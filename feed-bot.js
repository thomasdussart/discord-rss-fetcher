//external library imports
var Dns = require("dns"); //for connectivity checking
var Url = require("url"); //for url parsing
var Uri = require("urijs"); //for finding urls within message strings
var Discord = require("discord.io"); //for obvious reasons
var FeedRead = require("feed-read"); //for rss feed reading
var JsonFile = require("jsonfile"); //reading/writing json

//my imports
var Log = require("./log.js"); //some very simple logging functions I made
var BotConfig = require("./bot-config.json"); //bot config file containing bot token
var Config = require("./config.json"); //config file containing other settings

var DiscordClient = {
	bot: null,
	startup: function () {
		//check if we can connect to discordapp.com to authenticate the bot
		Dns.resolve("discordapp.com", function (err) {
			if (err)
				Log.error("CONNECTION ERROR: Unable to locate discordapp.com to authenticate the bot", err);
			else {
				//if there was no error, go ahead and create and authenticate the bot
				DiscordClient.bot = new Discord.Client({
					token: BotConfig.token,
					autorun: true
				});

				//set up the bot's event handlers
				DiscordClient.bot.on("ready", DiscordClient.onReady);
				DiscordClient.bot.on("disconnect", DiscordClient.onDisconnect);
				DiscordClient.bot.on("message", DiscordClient.onMessage);
			}
		});
	},
	onReady: function () {
		Log.info("Registered/connected bot " + DiscordClient.bot.username + " - (" + DiscordClient.bot.id + ")");

		DiscordClient.checkPastMessagesForLinks(); //we need to check past messages for links on startup, but also on reconnect because we don't know what has happened during the downtime

		//set the interval function to check the feed
		intervalFunc = () => {
			Feed.check((err, articles) => {
				Links.validate(err, articles, DiscordClient.post);
			});
		};
	},
	onDisconnect: function (err, code) {
		Log.event("Bot was disconnected! " + (err ? err : "") + (code ? code : "No disconnect code provided.") + "\nClearing the feed timer and starting reconnect timer", "Discord.io");

		intervalFunc = DiscordClient.startup; //reassign the interval function to try restart the bot every 5 sec
	},
	onMessage: function (user, userID, channelID, message) {
		if (channelID === Config.channelID) {
			//contains a link, and is not the latest link from the rss feed
			if (Links.messageContainsLink(message) && (message !== Links.latestFromFeedlatestFeedLink)) {
				Log.event("Detected posted link in this message: " + message, "Discord.io");

				//extract the url from the string, and cache it
				Uri.withinString(message, function (url) {
					Links.cache(Links.standardise(url));
					return url;
				});
			}
			else {
				//iterate over all of our message triggers to see if the message sent requires any action
				for (var i = 0; i < DiscordClient.messageTriggers.length; i++) {
					var messageTrigger = DiscordClient.messageTriggers[i];
					if (message === messageTrigger.message) {
						//check if its locked to a channel or to a specific user
						if ((messageTrigger.channelID && messageTrigger.channelID === channelID) || (messageTrigger.userIDs && messageTrigger.userIDs.includes(userID)))
							messageTrigger.action(user, userID, channelID, message);
					}
				}
			}
		}
	},
	checkPastMessagesForLinks: function () {
		var limit = 100;
		Log.info("Attempting to check past " + limit + " messages for links");

		//get the last however many messsages from our discord channel
		DiscordClient.bot.getMessages({
			channelID: Config.channelID,
			limit: limit
		}, function (err, messages) {
			if (err) Log.error("Error fetching discord messages.", err);
			else {
				Log.info("Pulled last " + messages.length + " messages, scanning for links");

				var messageContents = messages.map((x) => { return x.content; }).reverse(); //extract an array of strings from the array of message objects

				for (var messageIdx in messageContents) {
					var message = messageContents[messageIdx];

					if (Links.messageContainsLink(message)) //test if the message contains a url
						//detect the url inside the string, and cache it
						Uri.withinString(message, function (url) {
							Links.cache(url);
							return url;
						});
				}
			}
		});
	},
	post: function (link) {
		//send a messsage containing the new feed link to our discord channel
		DiscordClient.bot.sendMessage({
			to: Config.channelID,
			message: Subscriptions.mention() + link
		});
	},
	//actions to perform when certain messages are detected, along with channel or user requirements
	messageTriggers: [
		{
			message: Config.userCommands.subscribe,
			action: (user, userID, channelID, message) => { if (Config.allowSubscriptions) Subscriptions.subscribe(user, userID, channelID, message); },
			channelID: Config.channelID
		},
		{
			message: Config.userCommands.unsubscribe,
			action: (user, userID, channelID, message) => { if (Config.allowSubscriptions) Subscriptions.unsubscribe(user, userID, channelID, message); },
			channelID: Config.channelID
		},
		{
			message: Config.userCommands.help,
			action: (user, userID, channelID, message) => {
				DiscordClient.bot.sendMessage({
					to: Config.channelID,
					message: Config.userCommands.join(" + ")
				});
			},
			channelID: Config.channelID
		},
		{
			message: Config.developerCommands.logUpload,
			action: (user, userID, channelID, message) => {
				DiscordClient.bot.uploadFile({
					to: channelID,
					file: Config.logFile
				});
			},
			userIDs: Config.developers
		},
		{
			message: Config.developerCommands.cacheList,
			action: (user, userID, channelID, message) => {
				DiscordClient.bot.sendMessage({
					to: channelID,
					message: Links.cached.join(", ")
				});
			},
			userIDs: Config.developers
		}
	]
};

var Subscriptions = {
	subscribe: function (user, userID, channelID, message) {
		DiscordClient.bot.addToRole({
			serverID: Config.serverID,
			userID: userID,
			roleID: Config.subscribersRoleID
		},
			(err) => {
				if (err) Log.raw(err); //log the error if there is an error
				else { //else go ahead and confirm subscription
					Log.event("Subscribed user " + (user ? user + "(" + userID + ")" : userID));

					DiscordClient.bot.sendMessage({
						to: channelID,
						message: "You have successfully subscribed"
					}, (err, response) => { setTimeout(() => { DiscordClient.bot.deleteMessage({ channelID: channelID, messageID: response.id }); }, Config.messageDeleteDelay); }); //delete the subscription confirmation message after a delay
				}
			});


	},

	unsubscribe: function (user, userID, channelID, message) {
		DiscordClient.bot.removeFromRole({
			serverID: Config.serverID,
			userID: userID,
			roleID: Config.subscribersRoleID
		},
			(err) => {
				if (err) Log.raw(err); //log the error if there is an error
				else { //else go ahead and confirm un-subscription
					Log.event("Unsubscribed user " + (user ? user + "(" + userID + ")" : userID));

					DiscordClient.bot.sendMessage({
						to: channelID,
						message: "You have successfully unsubscribed"
					}, (err, response) => { setTimeout(() => { DiscordClient.bot.deleteMessage({ channelID: channelID, messageID: response.id }); }, Config.messageDeleteDelay); }); //delete the un-subscription confirmation message after a delay
				}
			});
	},

	mention: function () {
		return Config.allowSubscriptions ? "<@&" + Config.subscribersRoleID + "> " : "";
	}
};

var YouTube = {
	url: {
		share: "http://youtu.be/",
		full: "http://www.youtube.com/watch?v=",
		createFullUrl: function (shareUrl) {
			return shareUrl.replace(YouTube.url.share, YouTube.url.full);
		},
		createShareUrl: function (fullUrl) {
			var shareUrl = fullUrl.replace(YouTube.url.full, YouTube.url.share);

			if (shareUrl.includes("&")) shareUrl = shareUrl.slice(0, fullUrl.indexOf("&"));

			return shareUrl;
		}
	},
};

var Links = {
	standardise: function (link) {
		link = link.replace("https://", "http://"); //cheaty way to get around http and https not matching
		if (Config.youtubeMode) link = link.split("&")[0]; //quick way to chop off stuff like &feature=youtube etc
		return link;
	},
	messageContainsLink: function (message) {
		var messageLower = message.toLowerCase();
		return messageLower.includes("http://") || messageLower.includes("https://") || messageLower.includes("www.");
	},
	cached: [],
	latestFeedLink: "",
	cache: function (link) {
		link = Links.standardise(link);

		if (Config.youtubeMode) link = YouTube.url.createShareUrl(link);

		//store the new link if not stored already
		if (!Links.isCached(link)) {
			Links.cached.push(link);
			Log.info("Cached URL: " + link);
		}

		if (Links.cached.length > Config.numLinksToCache) Links.cached.shift(); //get rid of the first array element if we have reached our cache limit
	},
	isCached: function (link) {
		link = Links.standardise(link);

		if (Config.youtubeMode)
			return Links.cached.includes(YouTube.url.createShareUrl(link));

		return Links.cached.includes(link);
	},
	validate: function (err, articles, callback) {
		if (err) Log.error("FEED ERROR: Error reading RSS feed.", err);
		else {
			var latestLink = Links.standardise(articles[0].link);
			if (Config.youtubeMode) latestLink = YouTube.url.createShareUrl(latestLink);

			//make sure we don't spam the latest link
			if (latestLink === Links.latestFeedLink)
				return;

			//make sure the latest link hasn't been posted already
			if (Links.isCached(latestLink)) {
				Log.info("Didn't post new feed link because already detected as posted " + latestLink);
			}
			else {
				callback(latestLink);

				Links.cache(latestLink); //make sure the link is cached, so it doesn't get posted again
			}

			Links.latestFeedLink = latestLink; //ensure our latest feed link variable is up to date, so we can track when the feed updates
		}
	}
};

var Feed = {
	urlObj: Url.parse(Config.feedUrl),
	check: function (callback) {
		Dns.resolve(Feed.urlObj.host, function (err) { //check that we have an internet connection (well not exactly - check that we have a connection to the host of the feedUrl)
			if (err) Log.error("CONNECTION ERROR: Cannot resolve host.", err);
			else FeedRead(Config.feedUrl, callback);
		});
	}
};

var intervalFunc = () => { }; //do nothing by default

//IIFE to kickstart the bot when the app loads
(function () {
	DiscordClient.startup();
	setInterval(() => { intervalFunc(); }, Config.pollingInterval);
})();