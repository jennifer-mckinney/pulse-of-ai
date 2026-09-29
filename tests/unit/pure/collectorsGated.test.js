// tests/unit/pure/collectorsGated.test.js
// The 19 gated collectors and the blocked 4, tested ONLY against
// hand-written fixtures (tests/fixtures/collectors/gated — no credentials
// exist yet). Blocked classes must refuse before any network call unless
// their official permission env is set.

'use strict';

const fs = require('fs');
const path = require('path');
const { HttpClient } = require('../../../src/collectors/http');
const { ADAPTERS } = require('../../../src/collectors');
const { getSource } = require('../../../src/config/source-registry');
const { GateClosedError, AccessDeniedError } = require('../../../src/collectors/errors');
const { parseScholarAlert, affiliationCity } = require('../../../src/collectors/adapters/academic');
const { stripSignatures } = require('../../../src/collectors/adapters/nonprofit');
const { billPath } = require('../../../src/collectors/adapters/policy');
const { fixtureTransport, readFixture, TEST_ENV, FIXTURE_ROOT } = require('../../helpers/fixtureTransport');

const NOW = Date.parse('2026-09-28T12:00:00Z');
const noSleep = () => Promise.resolve();
const G = f => `gated/${f}`;

function make(slug, routeId, routes, env = {}, extra = {}) {
    const source = getSource(slug);
    const route = source.routes.find(r => r.id === routeId);
    const transport = fixtureTransport(routes);
    const http = new HttpClient({ transport, env: TEST_ENV, sleep: noSleep });
    const cursor = extra.cursor || {};
    const c = new ADAPTERS[route.adapter]({ source, route, env: { ...TEST_ENV, ...env }, http, cursor, httpCache: {}, now: () => NOW, ...extra });
    return { c, transport, cursor };
}

describe('paid APIs (active only with their key)', () => {
    test('X: bearer token, since_id cursor, handle-free links, no author', async () => {
        const { c, transport, cursor } = make('x', 'recent-search', [[/api\.x\.com/, G('x-recent.json')]], { X_BEARER_TOKEN: 'tok' });
        const r = await c.collect();
        expect(r.payloads).toHaveLength(2);
        expect(transport.calls[0].headers.Authorization).toBe('Bearer tok');
        expect(cursor.sinceId).toBe('1840000000000000002');
        expect(r.payloads[0].url).toBe('https://x.com/i/web/status/1840000000000000001');
        expect(JSON.stringify(r.payloads)).not.toMatch(/REDACTED|author/);
        const next = make('x', 'recent-search', [[/api\.x\.com/, G('x-recent.json')]], { X_BEARER_TOKEN: 'tok' }, { cursor });
        await next.c.collect();
        expect(next.transport.calls[0].url).toMatch(/since_id=1840000000000000002/);
    });

    test('X refuses to construct without X_BEARER_TOKEN', () => {
        expect(() => make('x', 'recent-search', [])).toThrow(GateClosedError);
    });

    test('AP Media API: x-api-key header', async () => {
        const { c, transport } = make('ap', 'media-api', [[/api\.ap\.org/, G('ap-search.json')]], { AP_API_KEY: 'k' });
        const r = await c.collect();
        expect(transport.calls[0].headers['x-api-key']).toBe('k');
        expect(r.payloads[0]).toMatchObject({ title: 'AI tools spread in newsrooms', location: 'New York' });
    });

    test('Reuters Connect: client-credentials token, then GraphQL', async () => {
        const { c, transport } = make('reuters', 'reuters-connect', [
            [/auth\.thomsonreuters\.com/, G('reuters-token.json')],
            [/api\.reutersconnect\.com/, G('reuters-graphql.json')],
        ], { REUTERS_CONNECT_CLIENT_ID: 'id', REUTERS_CONNECT_CLIENT_SECRET: 's' });
        const r = await c.collect();
        expect(transport.calls[0].body).toMatch(/grant_type=client_credentials/);
        expect(transport.calls[1].headers.Authorization).toBe('Bearer rc.example-token');
        expect(JSON.parse(transport.calls[1].body).variables.q).toBe('artificial intelligence');
        expect(r.payloads[0].title).toBe('Chipmakers race to meet AI demand');
    });

    test('CNN Wire Store (licensed feed, JSON) with the contract credential', async () => {
        const { c, transport } = make('cnn', 'wire-store', [['https://wire.example/feed', G('licensed-feed.json')]],
            { CNN_LICENSE_REF: 'L', CNN_FEED_URL: 'https://wire.example/feed', CNN_API_KEY: 'k' });
        const r = await c.collect();
        expect(transport.calls[0].headers.Authorization).toBe('Bearer k');
        expect(r.payloads[0]).toMatchObject({ title: 'AI chatbots in customer service', location: 'Atlanta' });
    });

    test('Dow Jones paid tier (licensed feed, RSS) replaces the free WSJ feed', async () => {
        const { c } = make('wsj', 'dow-jones-feed', [['https://dj.example/feed', { body: readFixture(G('cato-feed.xml')) }]],
            { DOWJONES_API_KEY: 'k', DOWJONES_FEED_URL: 'https://dj.example/feed' });
        expect((await c.collect()).payloads).toHaveLength(1);
    });

    test('NYT Article Search (paid tier): content-level city from glocations', async () => {
        const { c } = make('nyt', 'article-search', [[/api\.nytimes\.com/, G('nyt-articlesearch.json')]], { NYT_API_KEY: 'k', NYT_LICENSE_REF: 'L' });
        const [p] = (await c.collect()).payloads;
        expect(p).toMatchObject({ location: 'London', location_basis: 'content' });
        expect(JSON.stringify(p)).not.toMatch(/REDACTED/);
    });

    test('Guardian Content API (commercial key)', async () => {
        const { c, transport } = make('guardian', 'content-api', [[/content\.guardianapis\.com/, G('guardian-content.json')]], { GUARDIAN_API_KEY: 'k' });
        const r = await c.collect();
        expect(transport.calls[0].url).toMatch(/tag=technology%2Fartificialintelligenceai/);
        expect(r.payloads[0].title).toBe('AI models and the energy grid');
    });

    test('IEEE Xplore needs key AND licence', async () => {
        expect(() => make('ieee_xplore', 'metadata-api', [], { IEEE_API_KEY: 'k' })).toThrow(/IEEE_LICENSE_REF/);
        const { c } = make('ieee_xplore', 'metadata-api', [[/ieeexploreapi/, G('ieee.json')]], { IEEE_API_KEY: 'k', IEEE_LICENSE_REF: 'L' });
        const [p] = (await c.collect()).payloads;
        expect(p.published_at).toBe('2026-09-27T00:00:00.000Z');
    });
});

describe('free-key and approval APIs', () => {
    test('YouTube: search.list then videos.list; publishedAfter cursor', async () => {
        const { c, transport, cursor } = make('youtube', 'data-api', [
            [/youtube\/v3\/search/, G('youtube-search.json')], [/youtube\/v3\/videos/, G('youtube-videos.json')],
        ], { YOUTUBE_API_KEY: 'k' });
        const r = await c.collect();
        expect(transport.calls).toHaveLength(2);
        expect(transport.calls[1].url).toMatch(/id=vid00000001%2Cvid00000002/);
        expect(r.payloads.map(p => p.language)).toEqual(['en', 'en']);
        expect(cursor.publishedAfter).toBe('2026-09-28T11:00:00Z');
        expect(JSON.stringify(r.payloads)).not.toMatch(/REDACTED|channel/i);
    });

    test('YouTube: no search results → no videos call', async () => {
        const { c, transport } = make('youtube', 'data-api', [[/search/, { body: '{"items":[]}' }]], { YOUTUBE_API_KEY: 'k' });
        expect((await c.collect()).payloads).toEqual([]);
        expect(transport.calls).toHaveLength(1);
    });

    test('TikTok Research: token then query; no username; no city from region', async () => {
        const { c, transport } = make('tiktok', 'research-api', [
            [/oauth\/token/, G('tiktok-token.json')], [/research\/video\/query/, G('tiktok-query.json')],
        ], { TIKTOK_RESEARCH_CLIENT_KEY: 'k', TIKTOK_RESEARCH_CLIENT_SECRET: 's' });
        const [p] = (await c.collect()).payloads;
        expect(JSON.parse(transport.calls[1].body).start_date).toBe('20260927');
        expect(p.location).toBe('');
        expect(JSON.stringify(p)).not.toMatch(/REDACTED/);
    });

    test('Springer, ScienceDirect, GovInfo search and Congress.gov', async () => {
        const spr = make('springerlink', 'meta-api', [[/springernature/, G('springer.json')]], { SPRINGER_API_KEY: 'k' });
        expect((await spr.c.collect()).payloads[0].url).toMatch(/link\.springer\.com/);
        const els = make('sciencedirect', 'search-api', [[/api\.elsevier\.com/, G('elsevier.json')]], { ELSEVIER_API_KEY: 'k', ELSEVIER_APPROVAL_REF: 'A' });
        const e = await els.c.collect();
        expect(els.transport.calls[0].method).toBe('PUT');
        expect(els.transport.calls[0].headers['X-ELS-APIKey']).toBe('k');
        expect(e.payloads[0].title).toBe('Deep learning for crop yield forecasting');
        const gov = make('govinfo', 'search-api', [[/api\.govinfo\.gov\/search/, G('govinfo-search.json')]], { GOVINFO_API_KEY: 'k' });
        expect((await gov.c.collect()).payloads[0]).toMatchObject({ location: 'Washington, D.C.' });
        const con = make('congress_gov', 'bill-api', [[/api\.congress\.gov/, G('congress-bills.json')]], { CONGRESS_API_KEY: 'k' });
        const cr = await con.c.collect();
        expect(cr.fetched).toBe(2);
        expect(cr.payloads).toHaveLength(1);   // the broadband bill is filtered out locally
        expect(cr.payloads[0].url).toBe('https://www.congress.gov/bill/119th-congress/house-bill/1001');
        expect(billPath('SJRES')).toBe('senate-joint-resolution');
        expect(billPath('XX')).toBe('xx');
    });

    test('PubMed: esearch → efetch; affiliation city only, never author names', async () => {
        const efetch = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article>
            <ArticleTitle>Deep learning for triage</ArticleTitle><Abstract><AbstractText Label="AIM">Machine learning triage.</AbstractText></Abstract>
            <AuthorList><Author><LastName>REDACTED</LastName><AffiliationInfo><Affiliation>Dept of X, Univ Y, London, UK.</Affiliation></AffiliationInfo></Author></AuthorList>
            </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
        const { c, transport } = make('pubmed', 'e-utilities', [
            [/esearch/, { body: '{"esearchresult":{"idlist":["123"]}}' }], [/efetch/, { body: efetch }],
        ], { NCBI_EMAIL: 'ops@example.org', NCBI_API_KEY: 'k' });
        const [p] = (await c.collect()).payloads;
        expect(transport.calls[0].url).toMatch(/tool=pulse-of-ai.*email=ops%40example\.org.*api_key=k/);
        expect(p).toMatchObject({ location: 'London', location_basis: 'content', url: 'https://pubmed.ncbi.nlm.nih.gov/123/' });
        expect(JSON.stringify(p)).not.toMatch(/REDACTED/);
        expect(affiliationCity(null)).toBeNull();
        const empty = make('pubmed', 'e-utilities', [[/esearch/, { body: '{"esearchresult":{"idlist":[]}}' }]]);
        expect((await empty.c.collect()).payloads).toEqual([]);
    });

    test('Meta Content Library: each product reads only its own export', async () => {
        const dir = path.join(FIXTURE_ROOT, 'gated/mcl');
        const env = { META_CONTENT_LIBRARY_APPROVAL_REF: 'MCL-1', META_CONTENT_LIBRARY_EXPORT_DIR: dir };
        const ig = make('instagram', 'mcl-export', [], env);
        const r = await ig.c.collect();
        expect(r.fetched).toBe(2);
        expect(r.payloads.map(p => p.text)).toEqual(['Generative AI art workshop this weekend']);
        expect(ig.transport.calls).toHaveLength(0);
        const wa = make('whatsapp', 'mcl-export', [], env);
        const w = await wa.c.collect();
        expect(w.payloads).toHaveLength(1);
        expect(JSON.stringify(w.payloads)).not.toMatch(/REDACTED|admin/);
        // Unchanged files are not re-read on the next run.
        const again = make('whatsapp', 'mcl-export', [], env, { cursor: wa.cursor });
        expect((await again.c.collect()).fetched).toBe(0);
        const fb = make('facebook', 'mcl-export', [], env);
        expect((await fb.c.collect()).payloads).toHaveLength(1);
    });

    test('JSTOR dataset loader', async () => {
        const { c } = make('jstor', 'tas-dataset', [], { JSTOR_DATASET_PATH: path.join(FIXTURE_ROOT, 'gated/jstor.jsonl') });
        const [p] = (await c.collect()).payloads;
        expect(p.title).toBe('Machine learning and the history of statistics');
        expect(JSON.stringify(p)).not.toMatch(/REDACTED/);
    });

    test('Google Scholar alerts over IMAP: snippets only, links never followed', async () => {
        const source = fs.readFileSync(path.join(FIXTURE_ROOT, 'gated/scholar-alert.eml'));
        const calls = [];
        const fakeImap = (opts) => ({
            connect: async () => calls.push(['connect', opts.host, opts.port, opts.secure]),
            getMailboxLock: async box => { calls.push(['lock', box]); return { release: () => calls.push(['release']) }; },
            search: async q => { calls.push(['search', q.from]); return [7, 8]; },
            fetchOne: async uid => ({ source }),
            logout: async () => calls.push(['logout']),
        });
        const env = { SCHOLAR_ALERTS_IMAP_HOST: 'imap.example', SCHOLAR_ALERTS_IMAP_USER: 'u', SCHOLAR_ALERTS_IMAP_PASSWORD: 'p' };
        const { c, cursor, transport } = make('google_scholar', 'alert-mailbox', [], env, { imapFactory: fakeImap, cursor: { lastUid: 7 } });
        const r = await c.collect();
        expect(calls[0]).toEqual(['connect', 'imap.example', 993, true]);
        expect(calls).toContainEqual(['search', 'scholaralerts-noreply@google.com']);
        expect(cursor.lastUid).toBe(8);
        expect(r.payloads.map(p => p.title)).toEqual(['Scaling laws for large language models revisited', 'Auditing artificial intelligence hiring tools']);
        expect(r.payloads.every(p => p.url === null)).toBe(true);
        expect(JSON.stringify(r.payloads)).not.toMatch(/REDACTED|scholar_url/);
        expect(transport.calls).toHaveLength(0);
        expect(calls[calls.length - 1]).toEqual(['logout']);
        expect(parseScholarAlert('', null, 'x')).toEqual([]);
    });
});

// F10-11: an endpoint URL from env must be https on a public host.
describe('env endpoint URLs are validated before any request (F10-11)', () => {
    test.each([
        ['http (cleartext)', 'http://wire.example/feed'],
        ['a loopback address', 'https://127.0.0.1/feed'],
        ['a compose service', 'https://web:3000/feed'],
        ['cloud metadata', 'https://169.254.169.254/latest/'],
        ['a data: URL', 'data:text/plain,x'],
    ])('the CNN contract feed refuses %s', (_, url) => {
        expect(() => make('cnn', 'wire-store', [], { CNN_LICENSE_REF: 'L', CNN_FEED_URL: url }))
            .toThrow(/CNN_FEED_URL must be an https URL on a public host/);
    });

    test('Dow Jones: a private feed URL is refused', () => {
        expect(() => make('wsj', 'dow-jones-feed', [], { DOWJONES_API_KEY: 'k', DOWJONES_FEED_URL: 'https://10.0.0.8/feed' }))
            .toThrow(GateClosedError);
    });

    test('Reuters: an http token-URL override would send the client secret in cleartext — refused', () => {
        const env = { REUTERS_CONNECT_CLIENT_ID: 'id', REUTERS_CONNECT_CLIENT_SECRET: 's' };
        expect(() => make('reuters', 'reuters-connect', [], { ...env, REUTERS_CONNECT_TOKEN_URL: 'http://auth.example/oauth' }))
            .toThrow(/REUTERS_CONNECT_TOKEN_URL must be an https URL/);
        expect(() => make('reuters', 'reuters-connect', [], { ...env, REUTERS_CONNECT_API_URL: 'https://localhost/graphql' }))
            .toThrow(/REUTERS_CONNECT_API_URL must be an https URL/);
        expect(() => make('reuters', 'reuters-connect', [], env)).not.toThrow();
    });

    test('WeChat: an http feed URL is refused', () => {
        expect(() => make('wechat', 'tencent-authorized-feed', [], {
            WECHAT_TENCENT_AUTHORIZATION_REF: 'T', WECHAT_AUTHORIZED_FEED_URL: 'http://feed.example/wx.xml', WECHAT_AUTHORIZED_FEED_HOST: 'feed.example',
        })).toThrow(/WECHAT_AUTHORIZED_FEED_URL must be an https URL/);
    });
});

describe('the blocked 4 — refuse unless their official permission env is set', () => {
    const BLOCKED = [
        ['wechat', 'tencent-authorized-feed', { WECHAT_TENCENT_AUTHORIZATION_REF: 'T', WECHAT_AUTHORIZED_FEED_URL: 'https://feed.example/wx.xml', WECHAT_AUTHORIZED_FEED_HOST: 'feed.example' }],
        ['telegram', 'bot-api-with-permission', { TELEGRAM_WRITTEN_PERMISSION_REF: 'P', TELEGRAM_BOT_TOKEN: 'b' }],
        ['researchgate', 'granted-dataset', { RESEARCHGATE_DATA_ACCESS_REF: 'R', RESEARCHGATE_DATASET_PATH: path.join(FIXTURE_ROOT, 'gated/researchgate.jsonl') }],
        ['cato', 'allowlisted-rss', { CATO_ALLOWLIST_REF: 'C' }],
    ];

    test.each(BLOCKED)('%s: no permission → GateClosedError before any request', (slug, routeId, env) => {
        const transport = fixtureTransport([]);
        const src = getSource(slug);
        const route = src.routes.find(r => r.id === routeId);
        const http = new HttpClient({ transport, env: TEST_ENV, sleep: noSleep });
        expect(() => new ADAPTERS[route.adapter]({ source: src, route, env: TEST_ENV, http })).toThrow(GateClosedError);
        // Credential without the permission reference is still refused.
        const [permKey] = Object.keys(env);
        const partial = { ...TEST_ENV, ...env, [permKey]: '' };
        expect(() => new ADAPTERS[route.adapter]({ source: src, route, env: partial, http })).toThrow(GateClosedError);
        expect(transport.calls).toHaveLength(0);
    });

    test('WeChat with authorization: reads the authorized feed only', async () => {
        const { c } = make('wechat', 'tencent-authorized-feed', [['https://feed.example/wx.xml', G('wechat-feed.xml')]], BLOCKED[0][2]);
        expect((await c.collect()).payloads[0].title).toBe('AI policy briefing');
        expect(() => make('wechat', 'tencent-authorized-feed', [], {
            ...BLOCKED[0][2], WECHAT_AUTHORIZED_FEED_URL: 'https://mp.weixin.qq.com/s/abc', WECHAT_AUTHORIZED_FEED_HOST: 'mp.weixin.qq.com',
        })).toThrow(/disallowed by robots/);
    });

    // G10-17: only the host Tencent's authorization names — exactly.
    test.each([
        ['another host', 'https://evil.example/wx.xml'],
        ['a subdomain of the authorized host', 'https://sub.feed.example/wx.xml'],
        ['a look-alike suffix', 'https://feed.example.evil.example/wx.xml'],
    ])('WeChat refuses %s (WECHAT_AUTHORIZED_FEED_HOST)', (_, url) => {
        expect(() => make('wechat', 'tencent-authorized-feed', [], { ...BLOCKED[0][2], WECHAT_AUTHORIZED_FEED_URL: url }))
            .toThrow(/is not the authorized host feed\.example/);
    });

    test('WeChat without WECHAT_AUTHORIZED_FEED_HOST is refused before any request', () => {
        const env = { ...BLOCKED[0][2] };
        delete env.WECHAT_AUTHORIZED_FEED_HOST;
        expect(() => make('wechat', 'tencent-authorized-feed', [], env)).toThrow(GateClosedError);
    });

    test('Telegram with permission: channel posts only, offset advances, no chat title', async () => {
        const { c, cursor } = make('telegram', 'bot-api-with-permission', [[/api\.telegram\.org/, G('telegram-updates.json')]], BLOCKED[1][2]);
        const r = await c.collect();
        expect(r.payloads).toHaveLength(1);
        expect(cursor.offset).toBe(900003);
        expect(JSON.stringify(r.payloads)).not.toMatch(/REDACTED|private message/);
    });

    test('ResearchGate with a grant: loads the delivered dataset only', async () => {
        const { c, transport } = make('researchgate', 'granted-dataset', [], BLOCKED[2][2]);
        expect((await c.collect()).payloads).toHaveLength(1);
        expect(transport.calls).toHaveLength(0);
    });

    test('Cato once allowlisted: RSS; a 403 wall still stops the run (never worked around)', async () => {
        const ok = make('cato', 'allowlisted-rss', [[/cato\.org\/rss\/recent-opeds/, G('cato-feed.xml')], [/cato\.org\/rss\//, { status: 304 }]], BLOCKED[3][2]);
        expect((await ok.c.collect()).payloads).toHaveLength(1);
        const walled = make('cato', 'allowlisted-rss', [[/cato\.org\/rss\//, { status: 403, body: '<html>Incapsula incident</html>' }]], BLOCKED[3][2]);
        await expect(walled.c.collect()).rejects.toThrow(/refused access \(HTTP 403\)/);
        const denied = make('cato', 'allowlisted-rss', [[/cato\.org\/rss\//, { status: 403 }]], BLOCKED[3][2]);
        await expect(denied.c.fetchItems()).rejects.toThrow();
        expect(denied.transport.calls.filter(c => /rss/.test(c.url)).length).toBeLessThanOrEqual(2);
        expect(AccessDeniedError).toBeDefined();
    });
});

describe('helpers', () => {
    test('Wikipedia signatures are stripped', () => {
        const html = 'Good point about LLMs. <a href="/wiki/User:Someone">Someone</a> (<a href="/wiki/User_talk:Someone">talk</a>) 12:34, 5 May 2026 (UTC)';
        expect(stripSignatures(html)).not.toMatch(/Someone|UTC/);
    });
});
