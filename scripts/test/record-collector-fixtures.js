#!/usr/bin/env node
// scripts/test/record-collector-fixtures.js
// Records the live responses the collector tests replay
// (tests/fixtures/collectors/recorded/). Run by hand, never in CI:
//
//   COLLECTOR_CONTACT_URL=... node scripts/test/record-collector-fixtures.js
//
// Each response is trimmed to a few items and identity fields (authors,
// usernames, owners, logins, avatars) are replaced with "REDACTED" before it
// is written — fixtures never carry personal data. manifest.json maps each
// request URL to its fixture file and records the recording time, which the
// tests use as "now" so the recency filter sees the same data it saw live.
// Gated APIs (no credentials available) have hand-written fixtures in
// tests/fixtures/collectors/gated/, shaped per each API's documentation.
//
// Kill switches apply here as everywhere (security review F4, migration
// 073): each target names the registry slug/route it records, and a target
// whose source or route is switched off — by env (COLLECTORS_ENABLED,
// COLLECTORS_DISABLED, SOURCE_<SLUG>_ENABLED, COLLECTORS_DISABLED_ROUTES) or
// by the database switches — is not fetched; its existing fixture and
// manifest entry are kept. The database state is read first; when it cannot
// be read, nothing is fetched (fail closed).

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { HttpClient } = require('../../src/collectors/http');
const { getSource, getRoute, killReason, routeKillReasons, staleRouteKills } = require('../../src/config/source-registry');

const DIR = path.join(__dirname, '../../tests/fixtures/collectors/recorded');
const IDENTITY_KEYS = new Set(['author', 'authors', 'owner', 'user', 'username', 'login', 'avatar_url',
    'avatar_template', 'last_poster_username', 'posters', 'display_username', 'user_id', 'author_id',
    '_highlightResult', 'channelTitle', 'channelId', 'creator']);

function scrub(v) {
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = IDENTITY_KEYS.has(k) ? 'REDACTED' : scrub(val);
        return out;
    }
    return v;
}

const only = (obj, keys) => Object.fromEntries(keys.filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));
// Wikipedia signatures link User: pages and DiscussionTools ids embed the
// signer's name — both are replaced with a placeholder account name.
const pseudonymizeWiki = s => s
    .replace(/User(_talk|%20talk| talk)?:[^"&#/<\\|\]]+/g, 'User$1:ExampleEditor')
    .replace(/"((?:c|h)-[^"]*)"/g, (m, id) => `"${id.replace(/(^c-|-)[^-"]+-(\d{14})/g, '$1ExampleEditor-$2')}"`)
    .replace(/>([^<>]{1,60})<\/a>(\s*\(<a[^>]*>talk<\/a>\))/g, '>ExampleEditor</a>$2');

const trimJson = (n, pick) => (body) => JSON.stringify(scrub(pick(JSON.parse(body), n)), null, 2);
const trimList = (n, key) => trimJson(n, (d) => {
    const parts = key.split('.');
    let node = d;
    for (const p of parts.slice(0, -1)) node = node[p];
    node[parts[parts.length - 1]] = node[parts[parts.length - 1]].slice(0, n);
    return d;
});
const trimArray = n => trimJson(n, d => d.slice(0, n));
const trimXml = n => (body) => {
    const tag = /<entry[\s>]/.test(body) ? 'entry' : 'item';
    let count = 0;
    return body.replace(new RegExp(`<${tag}[\\s>][\\s\\S]*?<\\/${tag}>`, 'g'), m => (++count <= n ? m : ''))
        .replace(/<(dc:creator|author)>[\s\S]*?<\/\1>/g, '<$1>REDACTED</$1>')
        .replace(/\/user\/[^/<"]+\//g, '/user/REDACTED/');
};

const TARGETS = [
    ['bbc_news/technology-rss', 'bbc-technology.xml', 'https://feeds.bbci.co.uk/news/technology/rss.xml', trimXml(4)],
    ['bbc_news/technology-rss', 'bbc-robots.txt', 'https://feeds.bbci.co.uk/robots.txt', b => b],
    ['guardian/ai-tag-rss', 'guardian-ai.xml', 'https://www.theguardian.com/technology/artificialintelligenceai/rss', trimXml(3)],
    ['cfr/site-feed', 'cfr-robots.txt', 'https://www.cfr.org/robots.txt', b => b],
    ['arxiv/export-api', 'arxiv-api.xml', 'https://export.arxiv.org/api/query?search_query=cat%3Acs.AI+OR+cat%3Acs.LG+OR+cat%3Acs.CL&sortBy=submittedDate&sortOrder=descending&max_results=3', trimXml(3)],
    ['hacker_news/algolia-search', 'hn-algolia.json', 'https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=4',
        trimJson(4, (d, n) => ({ hits: d.hits.slice(0, n).map(h => only(h, ['objectID', 'title', 'url', 'story_text', 'created_at_i'])) }))],
    ['stack_overflow/questions', 'stackexchange-so.json', 'https://api.stackexchange.com/2.3/questions?order=desc&sort=creation&site=stackoverflow&pagesize=2&filter=withbody&tagged=artificial-intelligence',
        trimJson(2, (d, n) => ({ ...only(d, ['has_more', 'quota_max', 'quota_remaining']), items: d.items.slice(0, n).map(i => only(i, ['question_id', 'title', 'body', 'creation_date', 'link', 'tags'])) }))],
    ['stack_overflow/questions', 'stackexchange-ai.json', 'https://api.stackexchange.com/2.3/questions?order=desc&sort=creation&site=ai&pagesize=2&filter=withbody',
        trimJson(2, (d, n) => ({ ...only(d, ['has_more', 'quota_max', 'quota_remaining']), items: d.items.slice(0, n).map(i => only(i, ['question_id', 'title', 'body', 'creation_date', 'link', 'tags'])) }))],
    ['github/repo-search', 'github-repos.json', 'https://api.github.com/search/repositories?q=topic%3Aartificial-intelligence&sort=updated&order=desc&per_page=3',
        trimJson(3, (d, n) => ({ total_count: d.total_count, items: d.items.slice(0, n).map(i => only(i, ['id', 'name', 'description', 'pushed_at', 'updated_at', 'topics'])) }))],
    ['gitlab/topic-projects', 'gitlab-projects.json', 'https://gitlab.com/api/v4/projects?topic=artificial-intelligence&order_by=last_activity_at&sort=desc&per_page=3&simple=true',
        trimJson(3, (d, n) => d.slice(0, n).map(p => only(p, ['id', 'name', 'description', 'last_activity_at', 'topics'])))],
    ['docker_hub/ai-namespace', 'dockerhub-ai.json', 'https://hub.docker.com/v2/namespaces/ai/repositories?ordering=last_updated&page_size=3', trimList(3, 'results')],
    ['hugging_face/daily-papers', 'hf-daily-papers.json', 'https://huggingface.co/api/daily_papers?limit=3',
        trimJson(3, (d, n) => d.slice(0, n).map(x => ({ ...only(x, ['title', 'publishedAt']), paper: only(x.paper, ['id', 'title', 'summary', 'publishedAt']) })))],
    ['hugging_face/forum-latest', 'hf-forum-latest.json', 'https://discuss.huggingface.co/latest.json',
        trimJson(4, (d, n) => ({ topic_list: { topics: d.topic_list.topics.slice(0, n).map(t => only(t, ['id', 'title', 'fancy_title', 'slug', 'created_at', 'excerpt', 'pinned'])) } }))],
    ['hugging_face/forum-latest', 'hf-forum-robots.txt', 'https://discuss.huggingface.co/robots.txt', b => b],
    ['pew/wp-rest-ai', 'pew-ai.json', 'https://www.pewresearch.org/wp-json/wp/v2/posts?categories=299&per_page=3&_fields=id%2Cdate_gmt%2Clink%2Ctitle%2Cexcerpt', trimArray(3)],
    ['internet_archive/advanced-search', 'ia-search.json', 'https://archive.org/advancedsearch.php?q=subject%3A%28%22artificial+intelligence%22%29&rows=3&output=json&sort%5B%5D=publicdate+desc&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&fl%5B%5D=publicdate', trimList(3, 'response.docs')],
    ['govinfo/collection-rss', 'govinfo-bills.xml', 'https://www.govinfo.gov/rss/bills.xml', trimXml(40)],
    ['substack/publication-feeds', 'substack-importai.xml', 'https://importai.substack.com/feed', trimXml(2)],
    ['openstreetmap/diary-rss', 'osm-diary.xml', 'https://www.openstreetmap.org/diary/rss', trimXml(5)],
    ['wikipedia/ai-talk-pages', 'wiki-category.json', 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2&action=query&list=categorymembers&cmtitle=Category%3AArtificial_intelligence&cmnamespace=0&cmlimit=5', b => JSON.stringify(scrub(JSON.parse(b)), null, 2)],
    ['wikipedia/ai-talk-pages', 'wiki-talk-ai.json', 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2&action=discussiontoolspageinfo&page=Talk%3AArtificial+intelligence&prop=threaditemshtml', (body) => {
        const d = JSON.parse(body);
        d.discussiontoolspageinfo.threaditemshtml = d.discussiontoolspageinfo.threaditemshtml.slice(-2);
        return pseudonymizeWiki(JSON.stringify(scrub(d), null, 2));
    }],
];

/**
 * Why a target must not be fetched, or null: its source or route is switched
 * off by a kill switch (env or database), or the source is in its refusal
 * cooldown. Only these — not the credential and permission gates, which
 * recording sidesteps by design.
 * @param {string} key   "slug/route"
 * @param {object} env
 * @param {object|null} gov  scripts/collect.js readGovernance(slug)
 */
function killedTarget(key, env, gov) {
    const [slug, routeId] = key.split('/');
    const src = getSource(slug);
    if (!src || !getRoute(src, routeId)) return `${key} is not a registry route`;
    const killed = killReason(src, env);
    if (killed) return killed;
    // The database kill switch and the refusal cooldown, exactly as the
    // supervised run and collect:smoke apply them (no data_sources row:
    // cannot be checked, so not fetched).
    try {
        require('../collect').assertDbGatesOpen(slug, gov, env);
    } catch (err) {
        return err.message;
    }
    const kills = gov.route_kills || [];
    if (staleRouteKills(src, kills).length) return `${slug} is held disabled by a database route kill switch`;
    return routeKillReasons(src, env, kills).get(routeId) || null;
}

async function main({ env = process.env, governance, http = new HttpClient(), dir = DIR, write = fs.writeFileSync,
    log = line => process.stdout.write(line + '\n') } = {}) {
    const readGov = governance || require('../collect').readGovernance;
    const govs = new Map();
    try {
        for (const slug of new Set(TARGETS.map(([key]) => key.split('/')[0]))) govs.set(slug, await readGov(slug));
    } catch (err) {
        log(`the database kill switches could not be read (${err.message}) — nothing was recorded`);
        return 2;
    }
    // The manifest on disk: its file map, its overall clock and each fixture's
    // own clock. A fixture that is not re-recorded keeps the clock it was
    // recorded at: the collector tests use that clock as "now", and a retained
    // fixture read at a later "now" would age out of the recency windows.
    let previous = {};
    let previousAt = null;
    let previousByFile = {};
    try {
        const prior = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        previous = prior.files || {};
        previousAt = prior.recordedAt || null;
        previousByFile = prior.recordedAtByFile || {};
    } catch {
        previous = {};
    }
    const startedAt = new Date().toISOString();
    const files = {};
    const byFile = {};
    let recorded = 0;
    // A fixture not re-recorded (skipped or failed) stays, with its own clock.
    const retain = (url) => {
        if (!previous[url]) return;
        files[url] = previous[url];
        const at = previousByFile[previous[url]] || previousAt;
        if (at) byFile[previous[url]] = at;
    };
    for (const [key, file, url, transform] of TARGETS) {
        const killed = killedTarget(key, env, govs.get(key.split('/')[0]));
        if (killed) {
            // Not fetched; the fixture recorded earlier stays in use.
            retain(url);
            log(`SKIPPED ${file} (${key}): ${killed}`);
            continue;
        }
        try {
            const res = await http.request(url, { minIntervalMs: 1000 });
            write(path.join(dir, file), transform(res.body));
            files[url] = file;
            byFile[file] = startedAt;
            recorded += 1;
            log(`recorded ${file}`);
        } catch (err) {
            retain(url);
            log(`FAILED ${file}: ${err.message}`);
        }
    }
    // Nothing recorded: every fixture and its clock stay exactly as they are,
    // so the manifest is left untouched rather than re-stamped.
    if (recorded === 0) {
        log('nothing was recorded; the manifest is unchanged');
        return 0;
    }
    // The overall clock moves only when EVERY target was recorded in this run;
    // a mixed run keeps the older overall clock and tells the truth per file.
    const manifest = {
        recordedAt: recorded === TARGETS.length || !previousAt ? startedAt : previousAt,
        recordedAtByFile: byFile,
        note: 'Live responses trimmed and identity-redacted by scripts/test/record-collector-fixtures.js',
        files,
    };
    write(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return 0;
}

/* istanbul ignore next -- process entry point; main() is tested directly */
if (require.main === module) {
    const db = require('../../src/db/connection');
    main().then(async (code) => { await db.closePool(); process.exit(code); });
}

module.exports = { main, killedTarget, TARGETS };
