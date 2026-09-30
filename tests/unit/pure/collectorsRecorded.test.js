// tests/unit/pure/collectorsRecorded.test.js
// Every keyless adapter family against RECORDED live responses
// (tests/fixtures/collectors/recorded, trimmed + identity-redacted by
// scripts/test/record-collector-fixtures.js). "now" is the recording time so
// the recency window sees what it saw live. No network: an unmatched URL
// throws in the fixture transport.

'use strict';

const { HttpClient } = require('../../../src/collectors/http');
const { ADAPTERS, buildCollectors } = require('../../../src/collectors');
const { getSource } = require('../../../src/config/source-registry');
const { PII_FIELDS } = require('../../../src/pipeline/ingest');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../../helpers/fixtureTransport');

const NOW = Date.parse(RECORDED_AT);
const noSleep = () => Promise.resolve();

function run(slug, routeId, routes, { cursor = {}, env = TEST_ENV } = {}) {
    const source = getSource(slug);
    const route = source.routes.find(r => r.id === routeId);
    const transport = fixtureTransport(routes);
    const http = new HttpClient({ transport, env, sleep: noSleep });
    const c = new ADAPTERS[route.adapter]({ source, route, env, http, cursor, httpCache: {}, now: () => NOW });
    return c.collect().then(r => ({ ...r, transport, collector: c, cursor }));
}

/** No stored payload may carry identity fields or a person-naming link. */
function expectNoIdentity(payloads) {
    const json = JSON.stringify(payloads);
    expect(json).not.toMatch(/REDACTED|ExampleEditor/);
    for (const p of payloads) {
        for (const f of PII_FIELDS) expect(p).not.toHaveProperty(f);
        if (p.url) expect(p.url).not.toMatch(/\/user\//);
    }
}

describe('RSS / Atom (publisher feeds, robots-gated)', () => {
    test('BBC Technology: robots checked, AI filter applied, publisher city London', async () => {
        const r = await run('bbc_news', 'technology-rss', [
            ['https://feeds.bbci.co.uk/robots.txt', 'recorded/bbc-robots.txt'],
            ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'recorded/bbc-technology.xml'],
        ]);
        expect(r.fetched).toBe(4);
        expect(r.transport.calls[0].url).toBe('https://feeds.bbci.co.uk/robots.txt');
        for (const p of r.payloads) {
            expect(p.location).toBe('London');
            expect(p.location_basis).toBe('publisher');
            expect(p.source_slug).toBe('bbc_news');
        }
        // G10-15: exact counts, not a sum that any split satisfies.
        expect(r.payloads).toHaveLength(2);
        expect(r.dropped).toEqual({ invalid: 0, old: 0, outOfScope: 2, duplicate: 0 });
    });

    test('Guardian AI tag (scope ai): every recent item kept, bylines never stored', async () => {
        const r = await run('guardian', 'ai-tag-rss', [['https://www.theguardian.com/technology/artificialintelligenceai/rss', 'recorded/guardian-ai.xml']]);
        expect(r.fetched).toBe(3);
        expect(r.dropped.outOfScope).toBe(0);
        expectNoIdentity(r.payloads);
    });

    test('Substack: items accepted only when the feed generator is Substack', async () => {
        const src = getSource('substack');
        const [ok, other] = src.routes[0].params.urls;
        const r = await run('substack', 'publication-feeds', [
            [ok, 'recorded/substack-importai.xml'],
            [other, { body: '<rss version="2.0"><channel><generator>Ghost</generator><item><title>AI</title><guid>g1</guid></item></channel></rss>' }],
            [/\/feed$/, { status: 304 }],
        ]);
        expect(r.fetched).toBe(2);
        expect(r.collector.warnings.map(w => w.text).join(' ')).toMatch(/not Substack — skipped/);
    });

    test('GovInfo collection RSS: many feeds, AI filter keeps only AI bills', async () => {
        const r = await run('govinfo', 'collection-rss', [
            ['https://www.govinfo.gov/rss/bills.xml', 'recorded/govinfo-bills.xml'],
            [/govinfo\.gov\/rss\//, { status: 304 }],
        ]);
        expect(r.fetched).toBe(40);
        for (const p of r.payloads) expect(p.text).toMatch(/artificial intelligence|\bAI\b|machine learning|algorithm|robot/i);
    });

    test('OpenStreetMap diary: geotags round to a registry city; /user/ links dropped', async () => {
        const r = await run('openstreetmap', 'diary-rss', [['https://www.openstreetmap.org/diary/rss', 'recorded/osm-diary.xml']]);
        expect(r.fetched).toBe(5);
        // The recorded entries are all off-topic: exactly 5 filtered out.
        expect(r.payloads).toHaveLength(0);
        expect(r.dropped.outOfScope).toBe(5);
        // G10-15: an AI entry geotagged in London (hand-made fixture) is kept,
        // located from its geotag (basis 'content'), its /user/ link dropped.
        const ai = await run('openstreetmap', 'diary-rss', [['https://www.openstreetmap.org/diary/rss', 'gated/osm-diary-ai.xml']]);
        expect(ai.payloads).toHaveLength(1);
        expect(ai.payloads[0]).toMatchObject({ location: 'London', location_basis: 'content', url: null });
        expect(ai.payloads[0].id).toMatch(/^diary-rss:fp:[0-9a-f]{64}$|^diary-rss:[0-9a-f]{64}$/);
        expectNoIdentity(ai.payloads);
    });

    test('a feed refused by robots is never fetched (CFR with the conservative reading)', async () => {
        const env = { ...TEST_ENV, CFR_FEED_PERMISSION_REF: 'x' };
        const source = getSource('cfr');
        const transport = fixtureTransport([['https://www.cfr.org/robots.txt', 'recorded/cfr-robots.txt'], ['https://www.cfr.org/feed', { body: '<rss version="2.0"><channel><title>CFR</title></channel></rss>' }]]);
        const http = new HttpClient({ transport, env: TEST_ENV, sleep: noSleep });
        // Without the confirmation env the robots reading is conservative → refused.
        const strict = new ADAPTERS.rss({ source, route: source.routes[0], env, http, now: () => NOW });
        strict.env = TEST_ENV;
        await expect(strict.fetchItems()).rejects.toThrow(/robots\.txt disallows \/feed \(conservative/);
        expect(transport.calls.map(c => c.url)).not.toContain('https://www.cfr.org/feed');
        // With CFR's confirmation recorded, literal RFC 9309 matching allows /feed.
        const literal = new ADAPTERS.rss({ source, route: source.routes[0], env, http, now: () => NOW });
        await literal.fetchItems();
        expect(transport.calls.map(c => c.url)).toContain('https://www.cfr.org/feed');
    });
});

describe('JSON APIs (recorded)', () => {
    test('arXiv export API', async () => {
        const r = await run('arxiv', 'export-api', [['https://export.arxiv.org/api/query?search_query=cat%3Acs.AI+OR+cat%3Acs.LG+OR+cat%3Acs.CL&sortBy=submittedDate&sortOrder=descending&max_results=50', 'recorded/arxiv-api.xml']]);
        expect(r.fetched).toBe(3);
        expect(r.payloads[0].url).toMatch(/arxiv\.org\/abs\//);
        expectNoIdentity(r.payloads);
        expect(r.transport.calls[0].url).toMatch(/sortBy=submittedDate/);
    });

    test('Hacker News Algolia: since cursor advances', async () => {
        const r = await run('hacker_news', 'algolia-search', [['https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=50', 'recorded/hn-algolia.json']]);
        expect(r.fetched).toBe(4);
        expect(r.cursor.since).toBeGreaterThan(0);
        const again = await run('hacker_news', 'algolia-search', [['https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=50&numericFilters=created_at_i%3E5', 'recorded/hn-algolia.json']], { cursor: { since: 5 } });
        expect(again.transport.calls[0].url).toMatch(/numericFilters=created_at_i%3E5/);
        expectNoIdentity(r.payloads);
    });

    test('Stack Exchange: both sites, keyless unless a key is set', async () => {
        // G10-21: the exact query each site is asked with, keyless and keyed.
        const SE = 'https://api.stackexchange.com/2.3/questions?order=desc&sort=creation&pagesize=30&filter=withbody';
        const SO = `${SE}&site=stackoverflow&tagged=artificial-intelligence`;
        const AI = `${SE}&site=ai`;
        const r = await run('stack_overflow', 'questions', [[SO, 'recorded/stackexchange-so.json'], [AI, 'recorded/stackexchange-ai.json']]);
        expect(r.fetched).toBe(4);
        expect(r.transport.calls).toHaveLength(2);
        const keyed = await run('stack_overflow', 'questions', [[`${SO}&key=k`, 'recorded/stackexchange-so.json'], [`${AI}&key=k`, 'recorded/stackexchange-ai.json']],
            { env: { ...TEST_ENV, STACKEXCHANGE_KEY: 'k' } });
        expect(keyed.transport.calls).toHaveLength(2);
    });

    test('Stack Exchange backoff is honoured on the next run', async () => {
        const r = await run('stack_overflow', 'questions', [[/./, { body: '{"items":[],"backoff":30}' }]]);
        expect(r.cursor.backoffUntil).toBe(NOW + 30000);
        const next = await run('stack_overflow', 'questions', [], { cursor: r.cursor });
        expect(next.transport.calls).toHaveLength(0);
    });

    test('GitHub repo search: no owner, no user link', async () => {
        const r = await run('github', 'repo-search', [['https://api.github.com/search/repositories?q=topic%3Aartificial-intelligence&sort=updated&order=desc&per_page=30', 'recorded/github-repos.json']]);
        expect(r.fetched).toBe(3);
        for (const p of r.payloads) expect(p.url).toBeNull();
        const tokened = await run('github', 'repo-search', [[/./, 'recorded/github-repos.json']], { env: { ...TEST_ENV, GITHUB_TOKEN: 't' } });
        expect(tokened.transport.calls[0].headers.Authorization).toBe('Bearer t');
    });

    test('GitHub issue search adds a created-since window', async () => {
        const r = await run('github', 'issue-search', [['https://api.github.com/search/issues?q=AI+in%3Atitle+type%3Aissue+created%3A%3E2026-09-28T02%3A59%3A38Z&sort=created&order=desc&per_page=30', { body: '{"items":[{"id":1,"title":"AI agent crash","body":"LLM","created_at":"2026-09-28T00:00:00Z","user":{"login":"x"}}]}' }]]);
        expect(decodeURIComponent(r.transport.calls[0].url)).toMatch(/created:>2026-/);
        expectNoIdentity(r.payloads);
    });

    test('GitLab topic projects', async () => {
        const r = await run('gitlab', 'topic-projects', [['https://gitlab.com/api/v4/projects?topic=artificial-intelligence&order_by=last_activity_at&sort=desc&per_page=20&simple=true', 'recorded/gitlab-projects.json']]);
        expect(r.fetched).toBe(3);
        expect(r.transport.calls[0].headers['PRIVATE-TOKEN']).toBeUndefined();
    });

    test('Docker Hub ai namespace (documented endpoint only)', async () => {
        const r = await run('docker_hub', 'ai-namespace', [['https://hub.docker.com/v2/namespaces/ai/repositories?ordering=last_updated&page_size=50', 'recorded/dockerhub-ai.json']]);
        expect(r.fetched).toBe(3);
        expect(r.transport.calls[0].url).not.toMatch(/\/v2\/search/);
        // G10-14: stable per repository (namespace/name), no timestamp.
        for (const p of r.payloads) expect(p.id).toMatch(/^ai-namespace:ai\/[\w.-]+$/);
    });

    test('Hugging Face daily papers', async () => {
        const r = await run('hugging_face', 'daily-papers', [['https://huggingface.co/api/daily_papers?limit=30', 'recorded/hf-daily-papers.json']]);
        expect(r.fetched).toBe(3);
        expect(r.payloads[0].url).toMatch(/huggingface\.co\/papers\//);
        expectNoIdentity(r.payloads);
    });

    test('Discourse forum (HF): robots checked, pinned topics skipped', async () => {
        const r = await run('hugging_face', 'forum-latest', [
            ['https://discuss.huggingface.co/robots.txt', 'recorded/hf-forum-robots.txt'],
            ['https://discuss.huggingface.co/latest.json', 'recorded/hf-forum-latest.json'],
        ]);
        expect(r.transport.calls[0].url).toMatch(/robots\.txt$/);
        expect(r.fetched).toBeGreaterThan(0);
        expectNoIdentity(r.payloads);
    });

    test('Pew WordPress REST (AI category 299)', async () => {
        // G10-15: the recording's posts are from 2026-09-17, older than the
        // 7-day window at RECORDED_AT, so the old check passed with ZERO
        // kept posts. Pew gets its own clock: the day after its newest post.
        const pewNow = Date.parse('2026-09-18T14:00:00Z');
        const source = getSource('pew');
        const route = source.routes.find(x => x.id === 'wp-rest-ai');
        const transport = fixtureTransport([['https://www.pewresearch.org/wp-json/wp/v2/posts?categories=299&per_page=50&_fields=id%2Cdate_gmt%2Clink%2Ctitle%2Cexcerpt', 'recorded/pew-ai.json']]);
        const http = new HttpClient({ transport, env: TEST_ENV, sleep: noSleep });
        const r = await new ADAPTERS[route.adapter]({ source, route, env: TEST_ENV, http, cursor: {}, httpCache: {}, now: () => pewNow }).collect();
        expect(r.fetched).toBe(3);
        expect(r.payloads).toHaveLength(3);
        expect(r.payloads.every(p => p.attribution === 'Pew Research Center')).toBe(true);
        expectNoIdentity(r.payloads);
    });

    test('Internet Archive advanced search (subject AI, date window)', async () => {
        const r = await run('internet_archive', 'advanced-search', [['https://archive.org/advancedsearch.php?q=subject%3A%28%22artificial+intelligence%22%29+AND+publicdate%3A%5B2026-09-26+TO+2026-09-29%5D&rows=50&output=json&sort%5B%5D=publicdate+desc&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=description&fl%5B%5D=publicdate', 'recorded/ia-search.json']]);
        expect(r.fetched).toBe(3);
        expect(decodeURIComponent(r.transport.calls[0].url)).toMatch(/publicdate:\[/);
        expect(r.payloads.every(p => p.location === '')).toBe(true);   // route overrides the SF home city
    });

    test('Wikipedia talk pages: category set cached, signatures and signer ids never kept', async () => {
        const routes = [
            [/list=categorymembers/, 'recorded/wiki-category.json'],
            [/list=recentchanges/, { body: '{"query":{"recentchanges":[{"title":"Talk:Artificial intelligence"}]}}' }],
            [/discussiontoolspageinfo/, 'recorded/wiki-talk-ai.json'],
        ];
        const env = { ...TEST_ENV, AUDIT_HASH_KEY: 'test-provenance-key-0123456789' };
        const r = await run('wikipedia', 'ai-talk-pages', routes, { env });
        expect(r.fetched).toBeGreaterThan(0);
        expect(r.cursor.set.length).toBeGreaterThan(0);
        for (const p of r.payloads) {
            expect(p.id).toMatch(/^ai-talk-pages:[0-9a-f]{64}$/);
            expect(p.text).not.toMatch(/\(UTC\)|ExampleEditor/);
            expect(p.attribution).toMatch(/CC BY-SA/);
        }
        const again = await run('wikipedia', 'ai-talk-pages', routes, { cursor: r.cursor, env });
        expect(again.transport.calls.filter(c => /categorymembers/.test(c.url))).toHaveLength(0);
    });

    // PR #22 security L7: comment ids embed usernames; never an unkeyed hash.
    test('Wikipedia talk pages without a provenance key: no request at all, a warning, nothing stored', async () => {
        const env = { ...TEST_ENV, AUDIT_HASH_KEY: '', PROVENANCE_KEY: '' };
        const r = await run('wikipedia', 'ai-talk-pages', [[/./, { body: '{}' }]], { env });
        expect(r.transport.calls).toHaveLength(0);
        expect(r.payloads).toEqual([]);
        expect(r.warnings.map(w => w.text)).toEqual([expect.stringMatching(/need PROVENANCE_KEY or AUDIT_HASH_KEY/)]);
    });
});

describe('buildCollectors (registry-wide)', () => {
    const { SOURCES, registryEnvVars } = require('../../../src/config/source-registry');
    const http = new HttpClient({ transport: fixtureTransport([]), env: TEST_ENV, sleep: noSleep });

    test('with no keys: only keyless routes are built; blocked and gated build nothing', () => {
        for (const s of SOURCES) {
            const cs = buildCollectors(s, { env: TEST_ENV, http });
            // Only operator settings (D1: the permission-gated acknowledgement)
            // may be required by a route that builds without any credential.
            for (const c of cs) {
                expect(c.route.requires || []).toEqual(c.route.permissionGated ? ['PERMISSION_GATED_FEEDS_ACCEPTED_BY'] : []);
            }
            if (['wechat', 'telegram', 'researchgate', 'cato', 'x', 'ap', 'reuters', 'cnn', 'tiktok'].includes(s.slug)) {
                expect(cs).toHaveLength(0);
            }
        }
    });

    test('with every credential set: every source builds, paid tiers replace free feeds', () => {
        const env = { ...TEST_ENV };
        for (const k of registryEnvVars()) {
            if (/COLLECTORS_ENABLED|COLLECTORS_DISABLED|GATE_APPROVED_BY/.test(k)) continue;   // G5 approval kept from TEST_ENV
            // Endpoint URLs must be https on a public host (F10-11); WeChat's
            // feed must sit on its authorized host (G10-17).
            // Reddit's User-Agent must follow Reddit's own format.
            env[k] = k === 'REDDIT_USER_AGENT' ? 'server:pulse-of-ai:v1.0.0 (by /u/example_user)'
                : k.endsWith('_URL') && k !== 'COLLECTOR_CONTACT_URL' ? 'https://feed.example.org/x'
                : k.endsWith('_HOST') ? 'feed.example.org' : '/tmp';
        }
        for (const s of SOURCES) {
            const cs = buildCollectors(s, { env, http });
            expect(cs.length).toBeGreaterThan(0);
        }
        expect(buildCollectors(getSource('guardian'), { env, http }).map(c => c.route.id)).toEqual(['content-api']);
        expect(buildCollectors(getSource('nyt'), { env, http }).map(c => c.route.id)).toEqual(['article-search']);
    });
});

// G10-21: the fixture matcher itself pins query strings.
test('fixtureTransport string matchers require the exact query parameters', async () => {
    const t = fixtureTransport([['https://api.example.org/q?a=1&b=2', { body: 'ok' }]]);
    await expect(t('https://api.example.org/q?b=2&a=1')).resolves.toMatchObject({ body: 'ok' });   // order-insensitive
    await expect(t('https://api.example.org/q?a=1')).rejects.toThrow(/no fixture/);
    await expect(t('https://api.example.org/q?a=1&b=2&c=3')).rejects.toThrow(/no fixture/);
    await expect(t('https://api.example.org/q?a=1&b=3')).rejects.toThrow(/no fixture/);
    const bare = fixtureTransport([['https://api.example.org/q', { body: 'ok' }]]);
    await expect(bare('https://api.example.org/q?x=1')).rejects.toThrow(/no fixture/);
});
