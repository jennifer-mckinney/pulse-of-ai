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

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { HttpClient } = require('../../src/collectors/http');

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
    ['bbc-technology.xml', 'https://feeds.bbci.co.uk/news/technology/rss.xml', trimXml(4)],
    ['bbc-robots.txt', 'https://feeds.bbci.co.uk/robots.txt', b => b],
    ['guardian-ai.xml', 'https://www.theguardian.com/technology/artificialintelligenceai/rss', trimXml(3)],
    ['cfr-robots.txt', 'https://www.cfr.org/robots.txt', b => b],
    ['arxiv-api.xml', 'https://export.arxiv.org/api/query?search_query=cat%3Acs.AI+OR+cat%3Acs.LG+OR+cat%3Acs.CL&sortBy=submittedDate&sortOrder=descending&max_results=3', trimXml(3)],
    ['hn-algolia.json', 'https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=4',
        trimJson(4, (d, n) => ({ hits: d.hits.slice(0, n).map(h => only(h, ['objectID', 'title', 'url', 'story_text', 'created_at_i'])) }))],
    ['stackexchange-so.json', 'https://api.stackexchange.com/2.3/questions?order=desc&sort=creation&site=stackoverflow&pagesize=2&filter=withbody&tagged=artificial-intelligence',
        trimJson(2, (d, n) => ({ ...only(d, ['has_more', 'quota_max', 'quota_remaining']), items: d.items.slice(0, n).map(i => only(i, ['question_id', 'title', 'body', 'creation_date', 'link', 'tags'])) }))],
    ['stackexchange-ai.json', 'https://api.stackexchange.com/2.3/questions?order=desc&sort=creation&site=ai&pagesize=2&filter=withbody',
        trimJson(2, (d, n) => ({ ...only(d, ['has_more', 'quota_max', 'quota_remaining']), items: d.items.slice(0, n).map(i => only(i, ['question_id', 'title', 'body', 'creation_date', 'link', 'tags'])) }))],
    ['github-repos.json', 'https://api.github.com/search/repositories?q=topic%3Aartificial-intelligence&sort=updated&order=desc&per_page=3',
        trimJson(3, (d, n) => ({ total_count: d.total_count, items: d.items.slice(0, n).map(i => only(i, ['id', 'name', 'description', 'pushed_at', 'updated_at', 'topics'])) }))],
    ['gitlab-projects.json', 'https://gitlab.com/api/v4/projects?topic=artificial-intelligence&order_by=last_activity_at&sort=desc&per_page=3&simple=true',
        trimJson(3, (d, n) => d.slice(0, n).map(p => only(p, ['id', 'name', 'description', 'last_activity_at', 'topics'])))],
    ['dockerhub-ai.json', 'https://hub.docker.com/v2/namespaces/ai/repositories?ordering=last_updated&page_size=3', trimList(3, 'results')],
    ['hf-daily-papers.json', 'https://huggingface.co/api/daily_papers?limit=3',
        trimJson(3, (d, n) => d.slice(0, n).map(x => ({ ...only(x, ['title', 'publishedAt']), paper: only(x.paper, ['id', 'title', 'summary', 'publishedAt']) })))],
    ['hf-forum-latest.json', 'https://discuss.huggingface.co/latest.json',
        trimJson(4, (d, n) => ({ topic_list: { topics: d.topic_list.topics.slice(0, n).map(t => only(t, ['id', 'title', 'fancy_title', 'slug', 'created_at', 'excerpt', 'pinned'])) } }))],
    ['hf-forum-robots.txt', 'https://discuss.huggingface.co/robots.txt', b => b],
    ['pew-ai.json', 'https://www.pewresearch.org/wp-json/wp/v2/posts?categories=299&per_page=3&_fields=id%2Cdate_gmt%2Clink%2Ctitle%2Cexcerpt', trimArray(3)],
    ['ia-search.json', 'https://archive.org/advancedsearch.php?q=subject%3A%28%22artificial+intelligence%22%29&rows=3&output=json&sort%5B%5D=publicdate+desc&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&fl%5B%5D=publicdate', trimList(3, 'response.docs')],
    ['govinfo-bills.xml', 'https://www.govinfo.gov/rss/bills.xml', trimXml(40)],
    ['substack-importai.xml', 'https://importai.substack.com/feed', trimXml(2)],
    ['osm-diary.xml', 'https://www.openstreetmap.org/diary/rss', trimXml(5)],
    ['wiki-category.json', 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2&action=query&list=categorymembers&cmtitle=Category%3AArtificial_intelligence&cmnamespace=0&cmlimit=5', b => JSON.stringify(scrub(JSON.parse(b)), null, 2)],
    ['wiki-talk-ai.json', 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2&action=discussiontoolspageinfo&page=Talk%3AArtificial+intelligence&prop=threaditemshtml', (body) => {
        const d = JSON.parse(body);
        d.discussiontoolspageinfo.threaditemshtml = d.discussiontoolspageinfo.threaditemshtml.slice(-2);
        return pseudonymizeWiki(JSON.stringify(scrub(d), null, 2));
    }],
];

async function main() {
    // Security F7 (diagnosis 2026-10-01): never ask a host the worker is
    // backing off from (the stored rate-limit holds, read only). Without a
    // reachable database the holds cannot be checked — said so, not hidden.
    let holds = null;
    try {
        holds = await require('../../src/collectors/state').loadHolds();
    } catch {
        process.stdout.write('rate-limit holds NOT checked (database unreachable)\n');
    }
    const http = new HttpClient({ holds: holds || {} });
    const manifest = { recordedAt: new Date().toISOString(), note: 'Live responses trimmed and identity-redacted by scripts/test/record-collector-fixtures.js', files: {} };
    for (const [file, url, transform] of TARGETS) {
        try {
            const res = await http.request(url, { minIntervalMs: 1000 });
            fs.writeFileSync(path.join(DIR, file), transform(res.body));
            manifest.files[url] = file;
            process.stdout.write(`recorded ${file}\n`);
        } catch (err) {
            process.stdout.write(`FAILED ${file}: ${err.message}\n`);
        }
    }
    fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

main();
