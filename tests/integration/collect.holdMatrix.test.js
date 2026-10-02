// tests/integration/collect.holdMatrix.test.js
// PR #45 matrix (docs/research/rate-limit-hold-matrix.md), the database rows:
// saveHolds / loadHolds / status / source health / the runner, for the two
// Copilot findings of review 5387566098 and the reviewers' order-dependence
// and success-reset cells.

'use strict';

const db = require('../../src/db/connection');
const { dbGet, dbRun } = db;
const state = require('../../src/collectors/state');
const rl = require('../../src/collectors/rate-limit');
const { sourceRows } = require('../../src/collectors/status');
const { conditionsFor } = require('../../src/collectors/source-health');
const { getSource } = require('../../src/config/source-registry');
const { runCollection } = require('../../src/collectors/runner');
const { snapshotTerms } = require('../../src/collectors/governance');
const { HttpClient } = require('../../src/collectors/http');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, TEST_ENV } = require('../helpers/fixtureTransport');

const iso = ms => new Date(ms).toISOString();
const idOf = async slug => (await dbGet('SELECT id FROM data_sources WHERE name = $1', [slug])).id;
const stateOf = async slug => dbGet('SELECT s.* FROM source_collection_state s JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = $1', [slug]);
const rowOf = async (slug, env = TEST_ENV) => (await sourceRows({ env })).find(r => r.slug === slug);

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

// CNN's terms page is www.cnn.com; its contract feed (a credential-class env URL the web
// process never sees) may be served from that same host.
describe('Copilot 4162210579: an env-derived route sharing the terms host keeps its collection hold', () => {
    const WORKER_ENV = { ...TEST_ENV, CNN_LICENSE_REF: 'CNN-2026-1', CNN_FEED_URL: 'https://www.cnn.com/feed' };
    const cnn = getSource('cnn');
    const HOST = 'www.cnn.com';
    const NOW = Date.now();
    const kinds = {
        '429': { until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: 3, weak: 0 },
        '403 + x-ratelimit-remaining 0': { until: iso(NOW + 600000), http_status: 403, signal: 'ratelimit_remaining_zero', count: 3, weak: 0, strong403: 3 },
        '503 + Retry-After': { until: iso(NOW + 600000), http_status: 503, signal: 'retry_after_5xx', count: 0, weak: 0 },
    };

    test.each(Object.entries(kinds))('%s: stored by the worker, read by the web process and the evaluator', async (name, h) => {
        const id = await idOf('cnn');
        const hold = { ...h, at: iso(NOW) };
        await state.saveHolds(id, { hosts: rl.sourceHosts(cnn, WORKER_ENV), changes: new Map([[HOST, hold]]), view: { [HOST]: hold }, src: cnn, env: WORKER_ENV });
        const st = await stateOf('cnn');
        // The worker marked the host: a route requests it, so it is NOT a terms-only host.
        expect(st.rate_limited_hosts[HOST].terms_only).toBe(false);
        // The web process (no feed URL) still serves it — masked as "configured host" — and the right fields.
        const row = await rowOf('cnn');
        if (h.signal === 'retry_after_5xx') {
            expect(row.server_backoff_until).toBe(hold.until);
            expect(row.server_backoff_hosts).toEqual([expect.objectContaining({ host: 'configured host' })]);
            expect(row.rate_limited_hosts).toEqual([]);
        } else {
            expect(row.rate_limited_hosts).toEqual([expect.objectContaining({ host: 'configured host' })]);
            expect(row.rate_limited_until).toBe(hold.until);
            // Three in a row opens the warning (the evaluator runs with the worker's env).
            const cond = conditionsFor(st, cnn, Date.now(), { env: WORKER_ENV, routeKills: [] });
            expect(cond.source_rate_limited).toMatchObject({ hosts: ['configured host'] });
        }
    });

    test('the same host with NO route using it is the terms page only: never published, never a warning, no server backoff time', async () => {
        const id = await idOf('cnn');
        const hold = { ...kinds['429'], at: iso(NOW) };
        await state.saveHolds(id, { hosts: [HOST], changes: new Map([[HOST, hold]]), view: { [HOST]: hold }, src: cnn, env: TEST_ENV });
        const st = await stateOf('cnn');
        expect(st.rate_limited_hosts[HOST].terms_only).toBe(true);
        const row = await rowOf('cnn');
        expect(row.rate_limited_hosts).toEqual([]);
        expect(row.rate_limited_until).toBeNull();
        expect(conditionsFor(st, cnn, Date.now(), { env: TEST_ENV, routeKills: [] }).source_rate_limited).toBeUndefined();
    });

    test('challenge and plain 403 create no hold at all (nothing to publish for either row)', async () => {
        expect(await stateOf('cnn')).toBeFalsy();
        expect(rl.rateLimitSignal({ status: 403, headers: {}, body: '' }, NOW, HOST)).toBeNull();
        expect(rl.rateLimitSignal({ status: 403, headers: { 'cf-mitigated': 'challenge', 'x-ratelimit-remaining': '0' }, body: '' }, NOW, HOST)).toBeNull();
    });
});

describe('Copilot 4162210606: a previous-release worker\'s retry-after key is a hold for EVERY source after migration 077', () => {
    // The key sits on github's row, with NO new-store hold anywhere.
    async function plantLegacy(host, status = 429) {
        const id = await idOf('github');
        await dbRun('INSERT INTO source_collection_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING', [id]);
        await dbRun(`UPDATE source_collection_state SET http_cache = http_cache || jsonb_build_object($2::text, jsonb_build_object('until', $3::text, 'status', $4::int))
                     WHERE source_id = $1`, [id, `retry-after:${host}`, iso(Date.now() + 1800000), status]);
    }

    test('loadHolds includes it (a row with an empty hold map too), 429 as a rate limit and 503 as a server backoff', async () => {
        await plantLegacy('hn.algolia.com', 429);
        await plantLegacy('example.org', 503);
        const holds = await state.loadHolds();
        expect(holds['hn.algolia.com']).toMatchObject({ signal: 'http_429', http_status: 429 });
        expect(holds['example.org']).toMatchObject({ signal: 'retry_after_5xx' });
    });

    test('another source (hacker_news) is skipped unsent', async () => {
        await plantLegacy('hn.algolia.com');
        const transport = fixtureTransport([[/./, { body: 'never' }]]);
        const summary = await runCollection({
            slugs: ['hacker_news'], triggeredBy: 'test', env: TEST_ENV, transport, now: () => Date.now(),
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} }, collectorCtx: { sleep: () => Promise.resolve() },
        });
        expect(transport.calls).toEqual([]);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'rate_limited' });
    });

    test('the governance terms fetch sends nothing to the host', async () => {
        await plantLegacy('docs.github.com');
        const transport = fixtureTransport([[/./, { body: 'terms' }]]);
        const http = new HttpClient({ transport, env: TEST_ENV, sleep: async () => {} });
        const [row] = await snapshotTerms({ http, slugs: ['github'], saveHoldChanges: async () => {} });
        expect(row.status).toBe('unreachable');
        expect(transport.calls).toEqual([]);
    });

    test('Reddit maintenance loads it into its client (state.loadHolds is the one source of the holds)', async () => {
        await plantLegacy('oauth.reddit.com');
        const http = new HttpClient({ transport: fixtureTransport([[/./, { body: 'never' }]]), env: TEST_ENV, holds: await state.loadHolds() });
        expect(http.heldError('oauth.reddit.com', 'https://oauth.reddit.com/api/info')).toMatchObject({ held: true });
    });
});

describe('saveHolds: concurrent savers in both orders, and success resets every row', () => {
    const NOW = Date.now();
    const rec = over => ({ until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW), ...over });

    test.each([['limit first', true], ['5xx first', false]])('a 429 and a 5xx hold saved concurrently (%s): the same row either way', async (_n, limitFirst) => {
        const hn = getSource('hacker_news');
        const id = await idOf('hacker_news');
        const limit = rec({ count: 4, until: iso(NOW + 24 * 3600000) });
        const five = rec({ http_status: 503, signal: 'retry_after_5xx', count: 0, until: iso(NOW + 3600000), at: iso(NOW + 1) });
        const order = limitFirst ? [limit, five] : [five, limit];
        for (const h of order) await state.saveHolds(id, { hosts: ['hn.algolia.com'], changes: new Map([['hn.algolia.com', h]]), view: {}, src: hn, env: TEST_ENV });
        expect((await stateOf('hacker_news')).rate_limited_hosts['hn.algolia.com']).toMatchObject({ signal: 'http_429', count: 4, until: limit.until });
    });

    test('a success clears the EXPIRED copies on every row (rate limit and 5xx alike) but keeps an active one', async () => {
        const hn = getSource('hacker_news');
        const idA = await idOf('hacker_news');
        const idB = await idOf('github');
        const expired = rec({ until: iso(NOW - 1000), at: iso(NOW - 600000) });
        const active = rec({ until: iso(NOW + 600000) });
        await dbRun('INSERT INTO source_collection_state (source_id) VALUES ($1), ($2) ON CONFLICT (source_id) DO NOTHING', [idA, idB]);
        await dbRun('UPDATE source_collection_state SET rate_limited_hosts = $2::jsonb WHERE source_id = $1', [idB, JSON.stringify({ 'hn.algolia.com': expired })]);
        await state.saveHolds(idA, { hosts: ['hn.algolia.com'], changes: new Map([['hn.algolia.com', null]]), view: {}, src: hn, env: TEST_ENV });
        expect((await stateOf('github')).rate_limited_hosts).toEqual({});
        await dbRun('UPDATE source_collection_state SET rate_limited_hosts = $2::jsonb WHERE source_id = $1', [idB, JSON.stringify({ 'hn.algolia.com': active })]);
        await state.saveHolds(idA, { hosts: ['hn.algolia.com'], changes: new Map([['hn.algolia.com', null]]), view: {}, src: hn, env: TEST_ENV });
        expect((await stateOf('github')).rate_limited_hosts['hn.algolia.com']).toBeDefined();
    });

    test('a hold under the www. twin of a route host is saved on the source', async () => {
        const gh = getSource('github');
        const id = await idOf('github');
        const h = rec({ until: iso(NOW + 600000) });
        await state.saveHolds(id, { hosts: rl.sourceHosts(gh, TEST_ENV), changes: new Map([['www.api.github.com', h]]), view: {}, src: gh, env: TEST_ENV });
        expect((await stateOf('github')).rate_limited_hosts['www.api.github.com']).toBeDefined();
    });
});

describe('status: every open route held by mixed causes', () => {
    test('a rate limit on one route and a server backoff on the other is rate_limited, never online', async () => {
        const gh = getSource('github');
        const id = await idOf('github');
        const NOW = Date.now();
        const limit = { until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) };
        const five = { until: iso(NOW + 600000), http_status: 503, signal: 'retry_after_5xx', count: 0, weak: 0, at: iso(NOW) };
        await state.saveHolds(id, {
            hosts: rl.sourceHosts(gh, TEST_ENV),
            changes: new Map([['api.github.com', limit], ['github.blog', five]]), view: {}, src: gh, env: TEST_ENV,
        });
        await dbRun('UPDATE source_collection_state SET last_success_at = NOW() WHERE source_id = $1', [id]);
        const row = await rowOf('github');
        expect(row.status).toBe('rate_limited');
        expect(row.online).toBe(false);
        expect(row.open_routes).toEqual([]);
    });
});

describe('hold keys: nothing prototype-like is ever a host', () => {
    test('sanitizeHolds drops single-label names such as constructor', () => {
        const out = rl.sanitizeHolds({ constructor: { until: iso(Date.now() + 60000) }, toString: { until: iso(Date.now() + 60000) }, 'ok.example': { until: iso(Date.now() + 60000) } });
        expect(Object.keys(out)).toEqual(['ok.example']);
        expect(rl.heldUntil({}, 'constructor')).toBeNull();
    });
});

describe('supervised and smoke runs fail closed when the holds cannot be read', () => {
    test('readGovernance rejects when loadHolds fails (no run starts)', async () => {
        const spy = jest.spyOn(state, 'loadHolds').mockRejectedValue(new Error('db down'));
        await expect(require('../../scripts/collect').readGovernance('hacker_news')).rejects.toThrow(/db down/);
        spy.mockRestore();
    });
});

describe('review round: long single hold, stale views, no-op saves', () => {
    const NOW = Date.now();

    test('ONE rate limit parking a host for 6 h or more opens the warning; a 5xx hold of any length never does', () => {
        const gh = getSource('github');
        const long = { until: iso(NOW + 7 * 3600000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) };
        expect(conditionsFor({ rate_limited_hosts: { 'api.github.com': long } }, gh, NOW).source_rate_limited).toMatchObject({ hosts: ['api.github.com'] });
        expect(conditionsFor({ rate_limited_hosts: { 'api.github.com': { ...long, until: iso(NOW + 3600000) } } }, gh, NOW).source_rate_limited).toBeUndefined();
        expect(conditionsFor({ rate_limited_hosts: { 'api.github.com': { ...long, signal: 'retry_after_5xx', http_status: 503, count: 0 } } }, gh, NOW).source_rate_limited).toBeUndefined();
    });

    test('an EXPIRED entry of the run\'s snapshot never brings a cleared streak back', async () => {
        const hn = getSource('hacker_news');
        const id = await idOf('hacker_news');
        const expired = { until: iso(NOW - 1000), http_status: 429, signal: 'http_429', count: 4, weak: 0, at: iso(NOW - 600000) };
        await state.saveHolds(id, { hosts: ['hn.algolia.com'], changes: new Map(), view: { 'hn.algolia.com': expired }, src: hn, env: TEST_ENV });
        expect((await stateOf('hacker_news')).rate_limited_hosts['hn.algolia.com']).toBeUndefined();
    });

    test('a save that changes nothing writes nothing (updated_at is untouched)', async () => {
        const hn = getSource('hacker_news');
        const id = await idOf('hacker_news');
        const h = { until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) };
        await state.saveHolds(id, { hosts: ['hn.algolia.com'], changes: new Map([['hn.algolia.com', h]]), view: {}, src: hn, env: TEST_ENV });
        const before = (await stateOf('hacker_news')).updated_at;
        await state.saveHolds(id, { hosts: ['hn.algolia.com'], changes: new Map(), view: { 'hn.algolia.com': h }, src: hn, env: TEST_ENV });
        expect((await stateOf('hacker_news')).updated_at).toEqual(before);
    });
});
