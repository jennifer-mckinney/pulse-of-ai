// tests/integration/collect.retryAfterHold.test.js
// Diagnosis 2026-10-01 (TLDR, route tldr-ai-rss): tldr.tech answered the
// 150 s poll with HTTP 429 and a Retry-After of a minute or more. The HTTP
// client capped the wait at 60 s, slept it inside the run and asked again;
// two of those overran the run's 120 s deadline, so ~half the runs were
// stored as error_kind 'deadline' (the 429 hidden) and every run re-asked
// the source sooner than it had said.
//
// PR #44 fixed it with its own Retry-After holds (`retry-after:<host>` keys
// in the HTTP cache); PR #45's merge UNIFIED them into the one rate-limit
// path (src/collectors/rate-limit.js): the 429 is classified as a rate limit
// and the host is held in source_collection_state.rate_limited_hosts. This
// file proves, through the REAL runner, that TLDR goes through that path:
// the 429 run is stored as rate_limited / 429 at once (never 'deadline'),
// the hold lands in rate_limited_hosts (never the HTTP cache), the next run
// — a NEW HttpClient, as in another worker replica or after a restart —
// sends nothing until the source's time, and a PR #44 key left in the HTTP
// cache by a previous-release worker is folded into the same store.

'use strict';

const { dbGet, dbAll, dbRun } = require('../../src/db/connection');
const { runCollection } = require('../../src/collectors/runner');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

const FEED = 'https://tldr.tech/api/rss/ai';
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>TLDR AI</title>
<item><title>AI agents ship to production</title><link>https://tldr.tech/ai/2026-09-30</link>
<guid>https://tldr.tech/ai/2026-09-30</guid><pubDate>${new Date(RECORDED_AT).toUTCString()}</pubDate>
<description>Machine learning and artificial intelligence news.</description></item></channel></rss>`;

async function collect(transport, signal) {
    return (await runCollection({
        slugs: ['tldr'], triggeredBy: 'test', env: TEST_ENV, transport, signal,
        now: () => Date.parse(RECORDED_AT),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
        collectorCtx: { sleep: () => Promise.resolve() },
    })).sources[0];
}
const stateOf = () => dbGet(`SELECT s.* FROM source_collection_state s JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = 'tldr'`);
// The next cadence tick: the poll interval has passed.
const nextPoll = () => dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'
    WHERE source_id = (SELECT id FROM data_sources WHERE name = 'tldr')`);
// The source's time has passed (the stored hold expired; its streak stays).
const holdPassed = () => dbRun(`UPDATE source_collection_state
    SET rate_limited_hosts = jsonb_set(rate_limited_hosts, '{tldr.tech,until}', to_jsonb('2000-01-01T00:00:00.000Z'::text)),
        rate_limited_until = NULL
    WHERE source_id = (SELECT id FROM data_sources WHERE name = 'tldr')`);
const runs = () => dbAll(
    `SELECT r.outcome, r.error_kind, r.http_status, r.requests FROM source_runs r
     JOIN data_sources ds ON ds.id = r.source_id WHERE ds.name = 'tldr' ORDER BY r.started_at`);
const holdKeys = cache => Object.keys(cache || {}).filter(k => k.startsWith('retry-after:'));

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('TLDR: HTTP 429 with a long Retry-After goes through the one rate-limit path', () => {
    it('run 1: rate_limited / 429 at once (never the deadline), held in rate_limited_hosts; run 2 (a fresh client): nothing sent; after the source\'s time: fetched, hold cleared', async () => {
        const deadline = new AbortController();
        const throttled = fixtureTransport([[FEED, { status: 429, headers: { 'retry-after': '3600' } }]]);
        const t0 = Date.now();
        const first = await collect(throttled, deadline.signal);
        expect(first).toMatchObject({ outcome: 'error', errorKind: 'rate_limited', httpStatus: 429, status: 'rate_limited' });
        expect(throttled.calls.filter(c => c.url === FEED)).toHaveLength(1);   // not retried inside the run
        expect(deadline.signal.aborted).toBe(false);

        const st = await stateOf();
        const hold = st.rate_limited_hosts['tldr.tech'];
        expect(hold).toMatchObject({ http_status: 429, signal: 'http_429', count: 1, weak: 0 });
        expect(Date.parse(hold.until)).toBeGreaterThanOrEqual(t0 + 3600 * 1000);
        expect(new Date(st.rate_limited_until).getTime()).toBe(Date.parse(hold.until));
        expect(st.rate_limited_routes).toEqual({ 'tldr-ai-rss': hold.until });
        // ONE hold store: nothing in the HTTP cache (the G10-5 rollback
        // target), the refused state untouched.
        expect(holdKeys(st.http_cache)).toEqual([]);
        expect(st).toMatchObject({ last_error_kind: 'rate_limited', last_http_status: 429, refusal_count: 0 });

        // Next tick, a fresh client: the stored hold alone keeps the source
        // from being asked — skipped before its claim, no run row.
        await nextPoll();
        const open = fixtureTransport([[FEED, { body: RSS }]]);
        const second = await collect(open);
        expect(open.calls).toHaveLength(0);
        expect(second).toMatchObject({ outcome: 'skipped', status: 'rate_limited' });
        expect(second.reason).toMatch(/backing off after a rate limit until .*routes held: tldr-ai-rss/);

        // Run 1: robots.txt + ONE feed request; run 2: no request, no run.
        expect(throttled.calls.map(c => new URL(c.url).pathname)).toEqual(['/robots.txt', '/api/rss/ai']);
        const stored = await runs();
        expect(stored.map(r => [r.error_kind, r.http_status, r.requests])).toEqual([['rate_limited', 429, 2]]);
        expect(stored.some(r => r.error_kind === 'deadline')).toBe(false);

        // The source's time has passed: the feed is fetched again and the
        // success clears the host's hold (and its streak).
        await holdPassed();
        await nextPoll();
        const later = fixtureTransport([[FEED, { body: RSS }]]);
        const third = await collect(later);
        expect(later.calls.filter(c => c.url === FEED)).toHaveLength(1);
        expect(third).toMatchObject({ outcome: 'ok', error: null });
        const after = await stateOf();
        expect(after.rate_limited_hosts).toEqual({});
        expect(after.rate_limited_until).toBeNull();
    });

    it('a PR #44 `retry-after:` key left in the HTTP cache (a previous-release worker) is folded into rate_limited_hosts and honoured', async () => {
        // Run once so the state row exists, then plant the legacy key.
        await collect(fixtureTransport([[FEED, { body: RSS }]]));
        const until = new Date(Date.now() + 1800 * 1000).toISOString();
        await dbRun(`UPDATE source_collection_state
            SET http_cache = http_cache || jsonb_build_object('retry-after:tldr.tech', jsonb_build_object('until', $1::text, 'status', 429))
            WHERE source_id = (SELECT id FROM data_sources WHERE name = 'tldr')`, [until]);
        await nextPoll();
        const open = fixtureTransport([[/./, { body: RSS }]]);
        const s = await collect(open);
        expect(open.calls).toEqual([]);
        expect(s).toMatchObject({ outcome: 'skipped', status: 'rate_limited' });
        const st = await stateOf();
        expect(st.rate_limited_hosts['tldr.tech']).toMatchObject({ until, http_status: 429, signal: 'http_429', count: 1 });

        // From now on the one store holds it: the next tick is skipped before
        // its claim, whatever the HTTP cache says.
        await dbRun(`UPDATE source_collection_state SET http_cache = http_cache - 'retry-after:tldr.tech'
            WHERE source_id = (SELECT id FROM data_sources WHERE name = 'tldr')`);
        await nextPoll();
        const again = fixtureTransport([[/./, { body: RSS }]]);
        expect(await collect(again)).toMatchObject({ outcome: 'skipped', status: 'rate_limited' });
        expect(again.calls).toEqual([]);
    });
});

// Copilot re-review #44: holds of routes WITHOUT a validator cache (most API
// collectors — arXiv here) are persisted too — in the one hold store
// (rate_limited_hosts), never the HTTP cache (PR #44 unified into #45).
describe('a route that passes no validator cache (arXiv)', () => {
    it('persists the 429 hold in the source state; the next run (a fresh client) sends nothing', async () => {
        const throttled = fixtureTransport([[/export\.arxiv\.org\/api/, { status: 429, headers: { 'retry-after': '3600' } }]]);
        const first = (await runCollection({
            slugs: ['arxiv'], triggeredBy: 'test', env: TEST_ENV, transport: throttled, now: () => Date.parse(RECORDED_AT),
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} }, collectorCtx: { sleep: () => Promise.resolve() },
        })).sources[0];
        expect(first).toMatchObject({ outcome: 'error', errorKind: 'rate_limited', httpStatus: 429 });
        const st = await dbGet(`SELECT s.rate_limited_hosts FROM source_collection_state s JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = 'arxiv'`);
        expect(st.rate_limited_hosts['export.arxiv.org']).toMatchObject({ http_status: 429, signal: 'http_429' });

        await dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'
            WHERE source_id = (SELECT id FROM data_sources WHERE name = 'arxiv')`);
        const open = fixtureTransport([[/./, { body: 'never' }]]);
        const second = (await runCollection({
            slugs: ['arxiv'], triggeredBy: 'test', env: TEST_ENV, transport: open, now: () => Date.parse(RECORDED_AT),
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} }, collectorCtx: { sleep: () => Promise.resolve() },
        })).sources[0];
        expect(open.calls).toEqual([]);
        expect(second).toMatchObject({ outcome: 'skipped', status: 'rate_limited' });
    });
});
