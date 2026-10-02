// tests/unit/pure/collectorReddit.test.js
// Reddit (#52) collector, OAuth client, field allowlist, request budget and
// subreddit selection — on fixtures HAND-WRITTEN FROM DOCS, UNVERIFIED
// AGAINST THE LIVE API (tests/fixtures/collectors/reddit/README.md). Reddit
// is never contacted: the fixture transport throws on any unmatched URL.

'use strict';

const { HttpClient } = require('../../../src/collectors/http');
const { buildCollectors } = require('../../../src/collectors');
const { getSource } = require('../../../src/config/source-registry');
const { PII_FIELDS } = require('../../../src/pipeline/ingest');
const { SEARCH_TERMS, isAiRelated } = require('../../../src/collectors/ai-filter');
const { RedditCollector } = require('../../../src/collectors/adapters/reddit');
const { RedditApi, clearTokenCache, TOKEN_URL } = require('../../../src/collectors/reddit/api');
const fields = require('../../../src/collectors/reddit/fields');
const budget = require('../../../src/collectors/reddit/budget');
const selection = require('../../../src/collectors/reddit/selection');
const { discoverSubreddits, buildQueries } = require('../../../src/collectors/reddit/discovery');
const { GateClosedError, AccessDeniedError } = require('../../../src/collectors/errors');
const { scrub } = require('../../../src/collectors/redact');
const { fixtureTransport, TEST_ENV } = require('../../helpers/fixtureTransport');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const noSleep = () => Promise.resolve();
const UA = 'server:pulse-of-ai:v1.0.0 (by /u/example_user)';
const ENV = Object.freeze({
    ...TEST_ENV,
    REDDIT_CLIENT_ID: 'fixture-client-id', REDDIT_CLIENT_SECRET: 'fixture-client-SECRET-123',
    REDDIT_USER_AGENT: UA, REDDIT_API_APPROVAL_REF: 'RBP-FIXTURE-1',
});
const source = getSource('reddit');
const route = source.routes[0];
const TOKEN = [TOKEN_URL, 'reddit/token.json'];
const newUrl = (sub, extra = '') => `https://oauth.reddit.com/r/${sub}/new?limit=100&raw_json=1${extra}`;

function collector({ routes, subs = ['OpenAI'], env = ENV, bud = new budget.MemoryBudget({ now: () => NOW }), cursor = {} }) {
    const transport = fixtureTransport(routes);
    const http = new HttpClient({ transport, env, sleep: noSleep });
    const c = new RedditCollector({
        source, route, env, http, cursor, now: () => NOW,
        redditBudget: bud, redditSelection: async () => ({ basis: 'provisional', subreddits: subs }),
    });
    return { c, transport, bud, cursor };
}

beforeEach(() => clearTokenCache());

describe('gate: closed without every Reddit variable', () => {
    test('no route is built until all four are set; the constructor refuses without them', () => {
        for (const k of ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'REDDIT_API_APPROVAL_REF']) {
            const env = { ...ENV, [k]: '' };
            expect([k, buildCollectors(source, { env, http: {} })]).toEqual([k, []]);
            expect(() => new RedditCollector({ source, route, env, http: {} })).toThrow(GateClosedError);
        }
        expect(buildCollectors(source, { env: ENV, http: {} })).toHaveLength(1);
    });

    test('a User-Agent not in Reddit\'s format is refused before any request', () => {
        for (const ua of ['PulseOfAI/1.0', 'server:pulse:v1 (by u/x)', `${UA}\r\nX-Evil: 1`]) {
            expect(() => new RedditCollector({ source, route, env: { ...ENV, REDDIT_USER_AGENT: ua }, http: {} }))
                .toThrow(/REDDIT_USER_AGENT must follow Reddit's format/);
        }
    });

    test('the kill switch builds nothing even with every credential', () => {
        // buildCollectors builds open routes; the runner checks sourceStatus
        // (tests/unit/pure/sourceRegistry.test.js) — here the registry gate.
        const { sourceStatus } = require('../../../src/config/source-registry');
        expect(sourceStatus(source, { ...ENV, SOURCE_REDDIT_ENABLED: 'false' }).status).toBe('disabled');
    });
});

describe('OAuth client-credentials token (fixture)', () => {
    test('POSTs Basic auth + grant_type to the token endpoint with Reddit\'s User-Agent, then calls oauth.reddit.com', async () => {
        const { c, transport } = collector({ routes: [TOKEN, [newUrl('OpenAI'), 'reddit/new-openai.json']] });
        await c.collect();
        const [tok, api] = transport.calls;
        expect(tok.url).toBe(TOKEN_URL);
        expect(tok.method).toBe('POST');
        expect(tok.body).toBe('grant_type=client_credentials');
        expect(tok.headers.Authorization).toBe(`Basic ${Buffer.from('fixture-client-id:fixture-client-SECRET-123').toString('base64')}`);
        expect(tok.headers['User-Agent']).toBe(UA);
        expect(api.url).toBe(newUrl('OpenAI'));
        expect(api.headers.Authorization).toBe('bearer fixture-bearer-token-1');
        expect(api.headers['User-Agent']).toBe(UA);
        expect(transport.calls.every(k => /^https:\/\/(www|oauth)\.reddit\.com\//.test(k.url))).toBe(true);
    });

    test('the token is cached until shortly before it expires (never stored in the cursor)', async () => {
        const first = collector({ routes: [TOKEN, [newUrl('OpenAI'), 'reddit/new-empty.json']] });
        await first.c.collect();
        const second = collector({ routes: [[newUrl('OpenAI'), 'reddit/new-empty.json']] });
        await second.c.collect();
        expect(second.transport.calls.map(k => k.url)).toEqual([newUrl('OpenAI')]);
        expect(JSON.stringify(first.cursor)).not.toMatch(/fixture-bearer-token|SECRET/);
    });

    test('a 401 on an API call fetches a new token and retries once', async () => {
        let apiCalls = 0;
        const { c, transport } = collector({ routes: [
            TOKEN,
            [newUrl('OpenAI'), () => (++apiCalls === 1 ? { status: 401, body: '' } : { status: 200, body: '{"kind":"Listing","data":{"children":[]}}' })],
        ] });
        await c.collect();
        expect(transport.calls.map(k => k.url)).toEqual([TOKEN_URL, newUrl('OpenAI'), TOKEN_URL, newUrl('OpenAI')]);
    });

    test('a refused token (401, or 200 without a bearer token) is access_denied; the secret never appears', async () => {
        for (const resp of [{ status: 401, body: '{"message":"Unauthorized"}' }, { status: 200, body: '{"error":"invalid_grant"}' }]) {
            clearTokenCache();
            const { c } = collector({ routes: [[TOKEN_URL, resp]] });
            const err = await c.collect().catch(e => e);
            expect(err).toBeInstanceOf(AccessDeniedError);
            expect(scrub(err.message, ENV)).not.toMatch(/SECRET|fixture-client-id|invalid_grant/);
        }
    });

    test('an API call may never leave oauth.reddit.com (a redirect to www.reddit.com is refused)', async () => {
        const { c } = collector({ routes: [
            TOKEN,
            [newUrl('OpenAI'), { status: 302, headers: { location: 'https://www.reddit.com/r/OpenAI/new.json' }, body: '' }],
        ] });
        await expect(c.collect()).rejects.toThrow(/refused/);
    });
});

describe('field allowlist: no author or user field is ever stored', () => {
    test('only allowlisted keys are read', () => {
        const picked = fields.pickAllowed({ name: 't3_a', author: 'x', author_fullname: 't2_x', author_anything_new: 'y', title: 't' });
        expect(Object.keys(picked).sort()).toEqual(['name', 'title']);
        for (const k of fields.ALLOWED_FIELDS) expect(k).not.toMatch(/^author|^approved_by|^banned_by|^media|preview|crosspost|awardings/);
    });

    test('collect(): permalink URL, t3 external id, no identity anywhere; NSFW, removed, profile and comment items dropped', async () => {
        const { c } = collector({ routes: [TOKEN, [newUrl('OpenAI'), 'reddit/new-openai.json']] });
        const r = await c.collect();
        expect(r.payloads.map(p => p.id)).toEqual(['data-api:t3_1aaa01', 'data-api:t3_1aaa02']);
        expect(r.dropped).toEqual(expect.objectContaining({ invalid: 0, old: 1, outOfScope: 1 }));
        expect(Object.values(c.drops).reduce((a, b) => a + b, 0)).toBe(4);   // NSFW, removed, u_ profile, t1
        const json = JSON.stringify(r.payloads);
        expect(json).not.toMatch(/Fixture(Author|Mod|Moderator|Crosspost|Video|Profile|Flair|Award)|fixture_mod|Another_User|t2_fixture|someone@example|fixturechannel/i);
        for (const p of r.payloads) {
            for (const f of PII_FIELDS) expect(p).not.toHaveProperty(f);
            expect(p.url).toMatch(/^https:\/\/www\.reddit\.com\/r\/OpenAI\/comments\/1aaa0[12]\//);
            expect(p.location).toBe('');
            expect(p.location_basis).toBeNull();
            expect(p.source_slug).toBe('reddit');
            expect(p.attribution).toBe('Reddit');
        }
        expect(r.payloads[0].text).toContain('u/[user]');
        expect(r.payloads[0].text).toContain('[email]');
        // The external link of a link post is never the canonical URL.
        expect(r.payloads[1].url).not.toContain('arxiv.org');
    });

    test('deletion signals (medium confidence) — ambiguous states count as deleted', () => {
        const ok = { kind: 't3', data: { name: 't3_a', subreddit: 'OpenAI', subreddit_type: 'public', title: 'AI', selftext: '' } };
        expect(fields.deletionSignal(ok)).toBeNull();
        expect(fields.deletionSignal({ ...ok, data: { ...ok.data, edited: 1790000000, locked: true } })).toBeNull();
        for (const bad of [
            null, { kind: 't1', data: {} }, { kind: 't3' },
            { ...ok, data: { ...ok.data, selftext: '[deleted]' } },
            { ...ok, data: { ...ok.data, title: '[removed]' } },
            { ...ok, data: { ...ok.data, removed_by_category: 'deleted' } },
            { ...ok, data: { ...ok.data, subreddit_type: 'private' } },
            { ...ok, data: { ...ok.data, subreddit_type: undefined } },
            { ...ok, data: { ...ok.data, over_18: true } },
        ]) expect(fields.deletionSignal(bad)).toEqual(expect.any(String));
        expect(fields.fullnameOf('data-api:t3_1aaa01')).toBe('t3_1aaa01');
        expect(fields.fullnameOf('data-api:fp:abc')).toBeNull();
    });
});

describe('request budget (100 QPM averaged over 10 minutes)', () => {
    test('the window cap is 90% of 1,000 and a run gets its share, split across the 7 subreddits', () => {
        expect(budget.WINDOW_CAP).toBe(900);
        expect(budget.runAllowance(150000)).toBe(225);
        expect(budget.pagesPerSubreddit(7, { cadenceMs: 150000, maxPages: 3 })).toBe(3);
        expect(budget.pagesPerSubreddit(7, { cadenceMs: 1000, maxPages: 3 })).toBe(1);
    });

    test('MemoryBudget: grants up to the cap, keeps a reserve, and rolls the window', async () => {
        let t = 0;
        const b = new budget.MemoryBudget({ cap: 3, windowMs: 1000, now: () => t });
        expect(await b.take({ reserve: 3 })).toBe(false);
        expect([await b.take(), await b.take(), await b.take(), await b.take()]).toEqual([true, true, true, false]);
        t = 1000;
        expect(await b.take()).toBe(true);
    });

    test('Reddit\'s X-Ratelimit headers stop all grants until the reset', async () => {
        let t = 0;
        const b = new budget.MemoryBudget({ now: () => t });
        expect(budget.parseRateHeaders({ 'X-Ratelimit-Remaining': '5.0', 'x-ratelimit-reset': '42', 'x-ratelimit-used': '995' }))
            .toEqual({ used: 995, remaining: 5, resetSec: 42 });
        await b.observe({ 'x-ratelimit-remaining': '50', 'x-ratelimit-reset': '42' });
        expect(await b.take()).toBe(true);
        await b.observe({ 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '42' });
        expect(await b.take()).toBe(false);
        t = 42000;
        expect(await b.take()).toBe(true);
    });

    test('an exhausted budget stops the run without an error; what was read is kept', async () => {
        const subs = ['OpenAI', 'MachineLearning', 'singularity'];
        const b = new budget.MemoryBudget({ cap: 3, now: () => NOW });   // token + 2 listings
        const { c, transport } = collector({ subs, bud: b, routes: [
            TOKEN, [newUrl('OpenAI'), 'reddit/new-openai.json'], [newUrl('MachineLearning'), 'reddit/new-empty.json'],
        ] });
        const r = await c.collect();
        expect(transport.calls).toHaveLength(3);
        expect(c.budgetExhausted).toBe(true);
        expect(r.payloads).toHaveLength(2);
        expect(r.warnings).toEqual([]);
    });

    test('pagination: a subreddit pages on (after=…) only while every post is newer than its cursor', async () => {
        const page1 = { kind: 'Listing', data: { after: 't3_p1', children: [
            { kind: 't3', data: { name: 't3_p1', subreddit: 'OpenAI', subreddit_type: 'public', title: 'AI one', selftext: '', created_utc: 1790679600, permalink: '/r/OpenAI/comments/p1/x/' } },
        ] } };
        const page2 = { kind: 'Listing', data: { after: 't3_p2', children: [
            { kind: 't3', data: { name: 't3_p2', subreddit: 'OpenAI', subreddit_type: 'public', title: 'AI two', selftext: '', created_utc: 1790670000, permalink: '/r/OpenAI/comments/p2/x/' } },
        ] } };
        const { c, transport, cursor } = collector({ cursor: { since: { OpenAI: 1790670000, Gone: 1 } }, routes: [
            TOKEN, [newUrl('OpenAI'), { body: JSON.stringify(page1) }],
            [newUrl('OpenAI', '&after=t3_p1'), { body: JSON.stringify(page2) }],
        ] });
        await c.collect();
        expect(transport.calls.map(k => k.url)).toEqual([TOKEN_URL, newUrl('OpenAI'),
            'https://oauth.reddit.com/r/OpenAI/new?limit=100&after=t3_p1&raw_json=1']);
        expect(cursor.since).toEqual({ OpenAI: 1790679600 });   // stale subreddits dropped
    });
});

describe('subreddit selection rule (Jennifer: top 7 by subscribers among those mentioning AI)', () => {
    const counts = (list) => new Map(list.map(([name, count]) => [name.toLowerCase(), { name, count }]));
    const about = (subscribers, extra = {}) => ({ about: { display_name: extra.name, subscribers, over18: false, subreddit_type: 'public', quarantine: false, ...extra } });

    test('ranks qualifying subreddits by subscribers — general subreddits included — and takes 7', () => {
        const c = counts([['technology', 400], ['Futurology', 90], ['ChatGPT', 900], ['singularity', 300], ['MachineLearning', 200],
            ['OpenAI', 500], ['ArtificialInteligence', 150], ['LocalLLaMA', 250], ['tinyAI', 5]]);
        const abouts = new Map([
            ['technology', about(17000000, { name: 'technology' })], ['futurology', about(21000000, { name: 'Futurology' })],
            ['chatgpt', about(11000000, { name: 'ChatGPT' })], ['singularity', about(4000000, { name: 'singularity' })],
            ['machinelearning', about(3000000, { name: 'MachineLearning' })], ['openai', about(2700000, { name: 'OpenAI' })],
            ['artificialinteligence', about(1900000, { name: 'ArtificialInteligence' })], ['localllama', about(700000, { name: 'LocalLLaMA' })],
        ]);
        const r = selection.rankSubreddits({ counts: c, abouts, minPosts: 20 });
        expect(r.selected).toEqual(['Futurology', 'technology', 'ChatGPT', 'singularity', 'MachineLearning', 'OpenAI', 'ArtificialInteligence']);
        expect(r.ranking.find(x => x.subreddit === 'LocalLLaMA')).toEqual(expect.objectContaining({ rank: 8, selected: false }));
        expect(r.qualifying).not.toContain('tinyAI');
    });

    test('excludes NSFW, non-public, quarantined, user-profile, deny-listed, unavailable and count-less subreddits, with reasons', () => {
        const c = counts([['nsfwAI', 50], ['privAI', 50], ['quarAI', 50], ['antiai', 50], ['u_someone', 50], ['goneAI', 50], ['nocount', 50], ['okAI', 50]]);
        const abouts = new Map([
            ['nsfwai', about(9e6, { over18: true })], ['privai', about(9e6, { subreddit_type: 'private' })],
            ['quarai', about(9e6, { quarantine: true })], ['antiai', about(9e6)], ['goneai', { about: null, unavailable: 'HTTP 404' }],
            ['nocount', about(undefined)], ['okai', about(10)],
        ]);
        const r = selection.rankSubreddits({ counts: c, abouts, minPosts: 20 });
        expect(r.selected).toEqual(['okAI']);
        const why = Object.fromEntries(r.exclusions.map(e => [e.subreddit, e.reason]));
        expect(why).toEqual({
            nsfwAI: 'NSFW (over18)', privAI: 'not public (subreddit_type private)', quarAI: 'quarantined',
            antiai: expect.stringMatching(/^deny list: activist community/), u_someone: 'user profile, not a community',
            goneAI: 'about unavailable (HTTP 404)', nocount: 'no subscriber count returned',
        });
    });

    test('REDDIT_MIN_AI_POSTS_7D defaults to 20; only a positive integer overrides it', () => {
        expect(selection.minAiPosts({})).toBe(20);
        expect(selection.minAiPosts({ REDDIT_MIN_AI_POSTS_7D: '35' })).toBe(35);
        for (const v of ['0', '-3', '2.5', 'many', '']) expect(selection.minAiPosts({ REDDIT_MIN_AI_POSTS_7D: v })).toBe(20);
    });

    test('the provisional list is 7 subreddits, marked provisional, all counts unverified', () => {
        const p = selection.provisionalSelection();
        expect(p.basis).toBe('provisional');
        expect(p.subreddits).toEqual(['technology', 'Futurology', 'ChatGPT', 'singularity', 'MachineLearning', 'OpenAI', 'ArtificialInteligence']);
        expect(p.note).toMatch(/provisional until the first API ranking/);
        expect(p.candidates.map(x => x.subreddit)).toEqual(['artificial', 'ClaudeAI', 'LocalLLaMA', 'AIethics']);
        expect(selection.DENY_LIST.map(d => d.subreddit)).toEqual(['antiai']);
    });

    test('the discovery search uses the shared AI filter terms', () => {
        for (const t of SEARCH_TERMS) expect([t, isAiRelated(t.replace(/"/g, ''))]).toEqual([t, true]);
        const qs = buildQueries();
        expect(qs.join(' OR ').split(' OR ')).toEqual([...SEARCH_TERMS]);
        for (const q of qs) expect(q.length).toBeLessThanOrEqual(400);
    });
});

describe('discovery (a-d) against a scripted API', () => {
    const post = (name, subreddit, title, created = 1790679600) => ({ kind: 't3', data: { name, subreddit, title, selftext: '', created_utc: created, author: 'FixtureAuthor' } });

    function fakeApi({ pages, abouts, budgetLeft = Infinity }) {
        const calls = [];
        let left = budgetLeft;
        return {
            calls,
            async listing(path, params) {
                if (left-- <= 0) throw new budget.BudgetExhaustedError();
                calls.push([path, params.after || null]);
                return pages[params.q] ? pages[params.q][params.after || ''] || { children: [], after: null } : { children: [], after: null };
            },
            async about(sub) {
                if (left-- <= 0) throw new budget.BudgetExhaustedError();
                calls.push(['about', sub]);
                const a = abouts[sub];
                if (a instanceof Error) throw a;
                return a;
            },
        };
    }

    test('counts distinct AI posts per subreddit in 7 days, qualifies, looks up and ranks', async () => {
        const [q1, q2] = buildQueries();
        const many = (sub, n, prefix) => Array.from({ length: n }, (_, i) => post(`t3_${prefix}${i}`, sub, 'New AI model'));
        const pages = {
            [q1]: {
                '': { children: [...many('technology', 15, 'a'), post('t3_nai', 'technology', 'Cat pictures')], after: 't3_x' },
                // sort=new: the first post older than the window ends the paging
                t3_x: { children: [...many('technology', 10, 'b'), ...many('ChatGPT', 25, 'c'), ...many('smallsub', 3, 'd'),
                    post('t3_old', 'technology', 'AI', 1790000000)], after: 't3_y' },
                t3_y: { children: many('technology', 50, 'z'), after: null },
            },
            [q2]: { '': { children: [...many('ChatGPT', 5, 'c'), ...many('antiai', 30, 'e')], after: null } },   // c-duplicates count once
        };
        const err404 = Object.assign(new Error('HTTP 404'), { status: 404 });
        const api = fakeApi({ pages, abouts: {
            technology: { display_name: 'technology', subscribers: 17000000, subreddit_type: 'public', over18: false },
            ChatGPT: err404,
        } });
        const d = await discoverSubreddits({ api, env: {}, now: () => NOW });
        expect(d.complete).toBe(true);
        expect(d.selected).toEqual(['technology']);
        expect(d.ranking).toEqual([{ subreddit: 'technology', ai_posts_7d: 25, subscribers: 17000000, rank: 1, selected: true }]);
        expect(Object.fromEntries(d.exclusions.map(e => [e.subreddit, [e.ai_posts_7d, e.reason]]))).toEqual({
            ChatGPT: [25, 'about unavailable (HTTP 404)'], antiai: [30, expect.stringMatching(/^deny list/)],
        });
        expect(api.calls.filter(c => c[0] === 'about').map(c => c[1]).sort()).toEqual(['ChatGPT', 'technology']);   // antiai never requested
        expect(d.stats).toEqual(expect.objectContaining({ search_requests: 3, ai_posts: 83, posts_seen: 85, qualifying: 3, about_lookups: 1 }));
        expect(d.windowStart).toBe(new Date(NOW - 7 * 86400000).toISOString());
    });

    test('a budget that runs out makes the discovery incomplete: nothing is selected', async () => {
        const [q1] = buildQueries();
        const api = fakeApi({ budgetLeft: 1, pages: { [q1]: { '': { children: [post('t3_a', 'x', 'AI')], after: 't3_a' } } }, abouts: {} });
        const d = await discoverSubreddits({ api, env: {}, now: () => NOW });
        expect(d.complete).toBe(false);
        expect(d.selected).toEqual([]);
    });

    test('a refusal (401) propagates', async () => {
        const api = { listing: async () => { throw Object.assign(new AccessDeniedError('no'), { status: 401 }); } };
        await expect(discoverSubreddits({ api, env: {}, now: () => NOW })).rejects.toThrow(AccessDeniedError);
    });
});

describe('rate limits (grumpy #1, diagnosis 2026-10-01): Reddit asked us to wait — we stop', () => {
    const { RateLimitedError } = require('../../../src/collectors/errors');
    const INFO = /oauth\.reddit\.com\/api\/info/;
    const names = n => Array.from({ length: n }, (_, i) => `t3_r${i}`);
    const apiOver = (routes, holds = {}) => {
        const transport = fixtureTransport(routes);
        const http = new HttpClient({ transport, env: ENV, sleep: noSleep, holds });
        const bud = new budget.MemoryBudget({ now: () => NOW });
        return { api: new RedditApi({ http, env: ENV, budget: bud, requestOptions: x => ({ robots: false, ...x }) }), http, transport, bud };
    };

    test('a 429 with Retry-After 600 on /api/info: one request, held; the next call sends nothing and spends no budget', async () => {
        const { api, http, transport, bud } = apiOver([TOKEN, [INFO, { status: 429, headers: { 'retry-after': '600' }, body: '' }]]);
        await expect(api.info(names(2))).rejects.toBeInstanceOf(RateLimitedError);
        expect(transport.calls.filter(c => INFO.test(c.url))).toHaveLength(1);
        expect(http.holds['oauth.reddit.com']).toMatchObject({ http_status: 429, signal: 'http_429' });
        const used = bud.used;
        await expect(api.info(names(2))).rejects.toMatchObject({ held: true, host: 'oauth.reddit.com' });
        expect(transport.calls.filter(c => INFO.test(c.url))).toHaveLength(1);
        expect(bud.used).toBe(used);
    });

    test('Copilot: a held TOKEN host holds the API too, even with a cached token (prerequisite hosts)', async () => {
        const warm = apiOver([TOKEN, [INFO, { body: '{"kind":"Listing","data":{"children":[]}}' }]]);
        await warm.api.info(names(1));                           // the token is now cached
        const holds = { 'www.reddit.com': { until: new Date(Date.now() + 60000).toISOString(), http_status: 429, signal: 'http_429', count: 1, weak: 0 } };
        const { api, transport } = apiOver([TOKEN, [INFO, { body: '{}' }]], holds);
        await expect(api.info(names(1))).rejects.toMatchObject({ held: true, host: 'www.reddit.com' });
        expect(transport.calls).toHaveLength(0);
    });

    test('a held API host: no token is fetched and no request sent', async () => {
        const holds = { 'oauth.reddit.com': { until: new Date(Date.now() + 60000).toISOString(), http_status: 429, signal: 'http_429', count: 1, weak: 0 } };
        const { api, transport } = apiOver([TOKEN, [INFO, { body: '{}' }]], holds);
        await expect(api.info(names(1))).rejects.toMatchObject({ held: true });
        expect(transport.calls).toHaveLength(0);
    });

    test('discovery: a rate-limited about() stops the discovery (incomplete) — the next subreddit is never asked, none is dropped as unavailable', async () => {
        const [q1] = buildQueries();
        const many = (sub, n) => Array.from({ length: n }, (_, i) => ({ kind: 't3', data: { name: `t3_${sub}${i}`, subreddit: sub, title: 'New AI model', selftext: '', created_utc: 1790679600 } }));
        const calls = [];
        const api = {
            async listing(path, params) { return params.q === q1 && !params.after ? { children: [...many('alpha', 30), ...many('beta', 30)], after: null } : { children: [], after: null }; },
            async about(sub) {
                calls.push(sub);
                throw new RateLimitedError('oauth.reddit.com rate-limited us', { status: 429, host: 'oauth.reddit.com' });
            },
        };
        const d = await discoverSubreddits({ api, env: {}, now: () => NOW });
        expect(d).toMatchObject({ complete: false, selected: [], rateLimited: true });
        expect(calls).toHaveLength(1);
    });

    test('discovery: a HELD server backoff (5xx Retry-After hold) stops the discovery too — incomplete, never "unavailable"', async () => {
        const [q1] = buildQueries();
        const { HttpError } = require('../../../src/collectors/errors');
        const calls = [];
        const api = {
            async listing(path, params) { return params.q === q1 && !params.after ? { children: Array.from({ length: 30 }, (_, i) => ({ kind: 't3', data: { name: `t3_h${i}`, subreddit: 'alpha', title: 'AI news', selftext: '', created_utc: 1790679600 } })), after: null } : { children: [], after: null }; },
            async about(sub) { calls.push(sub); throw new HttpError('not requested: backing off after a server error', { held: true, status: 503 }); },
        };
        const d = await discoverSubreddits({ api, env: {}, now: () => NOW });
        expect(d.complete).toBe(false);
        expect(JSON.stringify(d.exclusions || [])).not.toMatch(/unavailable|HTTP 5/);
        expect(calls).toHaveLength(1);
    });

    test('discovery: a rate-limit 403 is not "subreddit unavailable (HTTP 403)"', async () => {
        const [q1] = buildQueries();
        const api = {
            async listing(path, params) { return params.q === q1 && !params.after ? { children: Array.from({ length: 30 }, (_, i) => ({ kind: 't3', data: { name: `t3_g${i}`, subreddit: 'gamma', title: 'AI news', selftext: '', created_utc: 1790679600 } })), after: null } : { children: [], after: null }; },
            async about() { throw new RateLimitedError('rate-limited', { status: 403, host: 'oauth.reddit.com', signal: 'ratelimit_remaining_zero' }); },
        };
        const d = await discoverSubreddits({ api, env: {}, now: () => NOW });
        expect(d.complete).toBe(false);
        expect(JSON.stringify(d.exclusions || [])).not.toMatch(/HTTP 403/);
    });
});

describe('discovery: plain 403s on /about (Copilot review)', () => {
    const { AccessDeniedError } = require('../../../src/collectors/errors');
    const [q1] = buildQueries();
    const listing = names => async (path, params) => (params.q === q1 && !params.after
        ? { children: names.flatMap(n => Array.from({ length: 30 }, (_, i) => ({ kind: 't3', data: { name: `t3_${n}${i}`, subreddit: n, title: 'AI news', selftext: '', created_utc: 1790679600 } }))), after: null }
        : { children: [], after: null });
    const denied = () => new AccessDeniedError('refused (HTTP 403)', { status: 403 });
    const ok = () => ({ display_name: 'x', subscribers: 5000, subreddit_type: 'public' });

    test('one private subreddit (a lone 403) is "unavailable", not a refusal', async () => {
        const answers = [denied, ok, ok];
        let i = 0;
        const api = { listing: listing(['alpha', 'beta', 'gamma']), async about() { const a = answers[i++]; if (a === denied) throw denied(); return ok(); } };
        const d = await discoverSubreddits({ api, env: {}, now: () => NOW });
        expect(d.complete).toBe(true);
        expect(JSON.stringify(d.exclusions)).toMatch(/HTTP 403/);
    });

    test('three 403s in a row (none succeeding between) are Reddit refusing us: the AccessDeniedError is rethrown', async () => {
        const api = { listing: listing(['alpha', 'beta', 'gamma', 'delta']), async about() { throw denied(); } };
        await expect(discoverSubreddits({ api, env: {}, now: () => NOW })).rejects.toBeInstanceOf(AccessDeniedError);
    });

    test('a bot wall at any status, a 451 or an escalated refusal is rethrown at once — never a private subreddit (grumpy 3)', async () => {
        for (const e of [
            new AccessDeniedError('bot wall', { status: 200, refusal: 'bot_wall' }),
            new AccessDeniedError('bot wall', { status: 302, refusal: 'bot_wall' }),
            new AccessDeniedError('bot wall', { status: 403, refusal: 'bot_wall' }),
            new AccessDeniedError('escalated', { status: 403, refusal: 'escalated' }),
            new AccessDeniedError('refused', { status: 451 }),
        ]) {
            const api = { listing: listing(['alpha', 'beta']), async about() { throw e; } };
            await expect(discoverSubreddits({ api, env: {}, now: () => NOW })).rejects.toBe(e);
        }
    });

    test('a 404 between 403s ends the run of 403s (security F8)', async () => {
        const seq = ['403', '403', '404', '403', '403', 'ok'];
        let i = 0;
        const api = { listing: listing(['a1', 'b1', 'c1', 'd1', 'e1', 'f1']), async about() {
            const k = seq[i++];
            if (k === '403') throw denied();
            if (k === '404') throw Object.assign(new Error('nf'), { status: 404 });
            return ok();
        } };
        expect((await discoverSubreddits({ api, env: {}, now: () => NOW })).complete).toBe(true);
    });

    test('a success between 403s resets the run', async () => {
        const seq = [true, true, false, true, true, false];
        let i = 0;
        const api = { listing: listing(['a1', 'b1', 'c1', 'd1', 'e1', 'f1']), async about() { if (seq[i++]) throw denied(); return ok(); } };
        const d = await discoverSubreddits({ api, env: {}, now: () => NOW });
        expect(d.complete).toBe(true);
    });
});

describe('RedditApi guards', () => {
    test('rejects malformed paths and /api/info batches over 100', async () => {
        const api = new RedditApi({ http: {}, env: ENV, budget: new budget.MemoryBudget() });
        await expect(api.get('/r/x/new?evil=1')).rejects.toThrow(/invalid Reddit API path/);
        await expect(api.info(Array.from({ length: 101 }, (_, i) => `t3_${i}`))).rejects.toThrow(/at most 100/);
        expect(await api.info([])).toEqual([]);
    });
});
