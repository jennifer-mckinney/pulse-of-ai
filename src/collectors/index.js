// src/collectors/index.js
// Adapter registry: registry route `adapter` key → collector class, and
// buildCollectors(), which instantiates one collector per OPEN route of a
// source (src/config/source-registry.js openRoutes). Closed routes are never
// built; a class constructed without its credential throws GateClosedError.

'use strict';

const { RssAtomCollector } = require('./base');
const social = require('./adapters/social');
const news = require('./adapters/news');
const academic = require('./adapters/academic');
const policy = require('./adapters/policy');
const nonprofit = require('./adapters/nonprofit');
const developer = require('./adapters/developer');
const forums = require('./adapters/forums');
const { RedditCollector } = require('./adapters/reddit');
const blocked = require('./adapters/blocked');
const { openRoutes } = require('../config/source-registry');

const ADAPTERS = Object.freeze({
    rss: RssAtomCollector,
    // social
    youtube: social.YouTubeCollector,
    'tiktok-research': social.TikTokResearchCollector,
    'x-recent-search': social.XRecentSearchCollector,
    'meta-content-library': social.MetaContentLibraryCollector,
    // news (paid / licensed tiers)
    'nyt-article-search': news.NytArticleSearchCollector,
    'guardian-content-api': news.GuardianContentApiCollector,
    'ap-media': news.ApMediaCollector,
    'reuters-connect': news.ReutersConnectCollector,
    'licensed-feed': news.LicensedFeedCollector,
    // academic
    arxiv: academic.ArxivCollector,
    pubmed: academic.PubmedCollector,
    springer: academic.SpringerCollector,
    elsevier: academic.ElsevierCollector,
    ieee: academic.IeeeCollector,
    'jstor-dataset': academic.JstorDatasetCollector,
    'scholar-imap': academic.ScholarImapCollector,
    // policy
    'govinfo-search': policy.GovinfoSearchCollector,
    congress: policy.CongressCollector,
    pew: policy.PewCollector,
    // non-profit
    'wikipedia-talk': nonprofit.WikipediaTalkCollector,
    'internet-archive': nonprofit.InternetArchiveCollector,
    // developer
    'github-search': developer.GithubSearchCollector,
    'gitlab-projects': developer.GitlabProjectsCollector,
    'dockerhub-namespace': developer.DockerHubNamespaceCollector,
    'hf-daily-papers': developer.HfDailyPapersCollector,
    discourse: developer.DiscourseCollector,
    // forums
    stackexchange: forums.StackExchangeCollector,
    'hn-algolia': forums.HnAlgoliaCollector,
    reddit: RedditCollector,
    // blocked 4
    'blocked-wechat': blocked.WeChatAuthorizedFeedCollector,
    'blocked-telegram': blocked.TelegramBotApiCollector,
    'blocked-researchgate': blocked.ResearchGateGrantedDatasetCollector,
    'blocked-cato': blocked.CatoAllowlistedRssCollector,
});

/**
 * @param {object} source  registry entry
 * @param {object} ctx     { env, http, cursor (per-source, keyed by route id), httpCache, now, imapFactory }
 * @returns {Array<import('./base').Collector>}
 */
function buildCollectors(source, ctx) {
    const env = ctx.env || process.env;
    const cursor = ctx.cursor || {};
    return openRoutes(source, env).map((route) => {
        const Cls = ADAPTERS[route.adapter];
        if (!Cls) throw new Error(`no collector adapter '${route.adapter}' (${source.slug}/${route.id})`);
        if (!cursor[route.id]) cursor[route.id] = {};
        return new Cls({ ...ctx, env, source, route, cursor: cursor[route.id] });
    });
}

module.exports = { ADAPTERS, buildCollectors };
