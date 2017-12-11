// @ts-ignore
const Config = require("../config.json");

const { promisify } = require("util");
const Camo = require("camo");
const Core = require("../../discord-bot-core");
const DiscordUtil = require("../../discord-bot-core").util;
const GetUrls = require("get-urls");
const Url = require("url");

// @ts-ignore
const readFeed = url => promisify(require("feed-read"))(url);
const resolveDns = promisify(require("dns").resolve);

module.exports = class FeedData extends Core.BaseEmbeddedData {
	constructor() {
		super();

		this.feedID = "";
		this.url = "";
		this.channelID = "";
		this.roleID = "";
		this.cachedLinks = [];
		this.maxCacheSize = 100;

		// @ts-ignore
		this.schema({
			feedID: String,
			url: String,
			channelID: String,
			roleID: String,
			cachedLinks: [String],
			maxCacheSize: Number
		});
	}

	cache(...elements) {
		const newArticles = elements
			.map(el => normaliseUrl(el))
			.filter(el => this.cachedLinks.indexOf(el) === -1);

		Array.prototype.push.apply(this.cachedLinks, newArticles);

		this.cachedLinks.splice(0, this.cachedLinks.length - this.maxCacheSize); //seeing as new links come in at the end of the array, we need to remove the old links from the beginning

		return elements.length > 0;
	}

	updatePastPostedLinks(guild) {
		const channel = guild.channels.get(this.channelID);

		if (!channel)
			return Promise.reject("Channel not found!");

		return new Promise((resolve, reject) => {
			channel.fetchMessages({ limit: 100 })
				.then(messages => {
					/* we want to push the links in oldest first, but discord.js returns messages newest first, so we need to reverse them
					 * discord.js returns a map, and maps don't have .reverse methods, hence needing to spread the elements into an array first */
					[...messages.values()].reverse().forEach(m => this.cache(...GetUrls(m.content)));
					resolve();
				})
				.catch(reject);
		});
	}

	fetchLatest(guild) {
		const dnsPromise = resolveDns(Url.parse(this.url).host).then(() => this._doFetchRSS(guild));

		dnsPromise.catch(err => DiscordUtil.dateDebugError("Connection error: Can't resolve host", err.message || err));

		return dnsPromise;
	}

	toString() {
		const blacklist = ["cachedLinks", "maxCacheSize"];
		return `\`\`\`JavaScript\n ${JSON.stringify(this, (k, v) => !blacklist.find(x => x === k) ? v : undefined, "\t")} \`\`\``;
	}

	_doFetchRSS(guild) {
		const feedPromise = readFeed(this.url).then(articles => this._processLatestArticle(guild, articles));

		feedPromise.catch(err => DiscordUtil.dateDebugError([`Error reading feed ${this.url}`, err]));

		return feedPromise;
	}

	_processLatestArticle(guild, articles) {
		if (articles.length === 0 || !articles[0].link)
			return false;

		const latest = normaliseUrl(articles[0].link);

		if (this.cachedLinks.indexOf(latest) > -1)
			return false;

		this.cache(latest);

		const channel = guild.channels.get(this.channelID),
			role = guild.roles.get(this.roleID);

		channel.send((role || "") + formatPost(articles[0]))
			.catch(err => DiscordUtil.dateDebugError(`Error posting in ${channel.id}: ${err.message || err}`));

		return true;
	}
};

function formatPost(article) {
	let message = "";

	if (article.title) message += `\n**${article.title}**`;
	if (article.content) message += article.content.length > Config.charLimit ? "\nArticle content too long for a single Discord message!" : `\n${article.content}`;
	if (article.link) message += `\n\n${normaliseUrl(article.link)}`;

	return message;
}

function normaliseUrl(url) {
	url = url.replace("https://", "http://"); //hacky way to treat http and https the same

	const parsedUrl = Url.parse(url);
	if (parsedUrl.host && parsedUrl.host.includes("youtube.com")) {
		const videoIDParam = (parsedUrl.query || "").split("&").find(x => x.startsWith("v="));
		if (videoIDParam) {
			const videoID = videoIDParam.substring(videoIDParam.indexOf("=") + 1, videoIDParam.length);
			url = "http://youtu.be/" + videoID;
		}
	}

	return url;
}