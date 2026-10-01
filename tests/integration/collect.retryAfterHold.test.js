// tests/integration/collect.retryAfterHold.test.js
// Diagnosis 2026-10-01 (TLDR, route tldr-ai-rss): tldr.tech answered the
// 150 s poll with HTTP 429 and a Retry-After of a minute or more. The HTTP
// client capped the wait at 60 s, slept it inside the run and asked again;
// two of those overran the run's 120 s deadline, so ~half the runs were
// stored as error_kind 'deadline' (the 429 hidden) and every run re-asked
// the source sooner than it had said.
//
// Through the REAL runner: the 429 run is stored as http_4xx / 429 at once,
// the hold is persisted in source_collection_state.http_cache, and the next
// run — a NEW HttpClient, as in another worker replica or after a restart —
// sends no request until the source's time has passed.

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
const runs = () => dbAll(
    `SELECT r.outcome, r.error_kind, r.http_status, r.requests, r.error FROM source_runs r
     JOIN data_sources ds ON ds.id = r.source_id WHERE ds.name = 'tldr' ORDER BY r.started_at`);

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('HTTP 429 with a long Retry-After (TLDR)', () => {
    it('is stored as http_4xx / 429 (never as the deadline), and the next run sends nothing until the source\'s time', async () => {
        const deadline = new AbortController();
        const throttled = fixtureTransport([[FEED, { status: 429, headers: { 'retry-after': '3600' } }]]);
        const t0 = Date.now();
        const first = await collect(throttled, deadline.signal);
        expect(first).toMatchObject({ outcome: 'error', errorKind: 'http_4xx', httpStatus: 429 });
        expect(throttled.calls.filter(c => c.url === FEED)).toHaveLength(1);   // not retried inside the run

        const st = await stateOf();
        const until = Date.parse(st.http_cache['retry-after:tldr.tech'].until);
        expect(until).toBeGreaterThanOrEqual(t0 + 3600 * 1000);
        expect(st.http_cache['retry-after:tldr.tech'].status).toBe(429);
        expect(st).toMatchObject({ last_error_kind: 'http_4xx', last_http_status: 429 });

        // Next tick, a fresh client (empty in-process holds): the persisted
        // hold alone keeps the source from being asked.
        await nextPoll();
        const open = fixtureTransport([[FEED, { body: RSS }]]);
        const second = await collect(open);
        expect(open.calls).toHaveLength(0);
        expect(second).toMatchObject({ outcome: 'error', errorKind: 'http_4xx', httpStatus: 429 });
        expect(second.error).toMatch(/not requested: tldr\.tech asked us to wait/);

        const stored = await runs();
        // Run 1: robots.txt + ONE feed request; run 2: no request at all.
        expect(throttled.calls.map(c => new URL(c.url).pathname)).toEqual(['/robots.txt', '/api/rss/ai']);
        expect(stored.map(r => [r.error_kind, r.http_status, r.requests])).toEqual([['http_4xx', 429, 2], ['http_4xx', 429, 0]]);
        expect(stored.some(r => r.error_kind === 'deadline')).toBe(false);
    });

    it('once the hold has passed the feed is fetched again and the hold is cleared', async () => {
        const throttled = fixtureTransport([[FEED, { status: 429, headers: { 'retry-after': '3600' } }]]);
        await collect(throttled);
        // The source's time has passed.
        await dbRun(`UPDATE source_collection_state
            SET http_cache = jsonb_set(http_cache, ARRAY['retry-after:tldr.tech'], jsonb_build_object('until', '2000-01-01T00:00:00.000Z', 'status', 429))
            WHERE source_id = (SELECT id FROM data_sources WHERE name = 'tldr')`);
        await nextPoll();
        const open = fixtureTransport([[FEED, { body: RSS }]]);
        const again = await collect(open);
        expect(open.calls.filter(c => c.url === FEED)).toHaveLength(1);
        expect(again).toMatchObject({ outcome: 'ok', error: null });
        expect((await stateOf()).http_cache['retry-after:tldr.tech']).toBeUndefined();
    });
});

// Copilot re-review #44: holds of routes WITHOUT a validator cache (most API
// collectors — arXiv here) are persisted too, through the source's HTTP cache.
describe('a route that passes no validator cache (arXiv)', () => {
    it('persists the 429 hold in the source state; the next run (a fresh client) sends nothing', async () => {
        const throttled = fixtureTransport([[/export\.arxiv\.org\/api/, { status: 429, headers: { 'retry-after': '3600' } }]]);
        const first = (await runCollection({
            slugs: ['arxiv'], triggeredBy: 'test', env: TEST_ENV, transport: throttled, now: () => Date.parse(RECORDED_AT),
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} }, collectorCtx: { sleep: () => Promise.resolve() },
        })).sources[0];
        expect(first).toMatchObject({ outcome: 'error', errorKind: 'http_4xx', httpStatus: 429 });
        const st = await dbGet(`SELECT s.http_cache FROM source_collection_state s JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = 'arxiv'`);
        expect(st.http_cache['retry-after:export.arxiv.org']).toMatchObject({ status: 429 });

        await dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'
            WHERE source_id = (SELECT id FROM data_sources WHERE name = 'arxiv')`);
        const open = fixtureTransport([[/./, { body: 'never' }]]);
        const second = (await runCollection({
            slugs: ['arxiv'], triggeredBy: 'test', env: TEST_ENV, transport: open, now: () => Date.parse(RECORDED_AT),
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} }, collectorCtx: { sleep: () => Promise.resolve() },
        })).sources[0];
        expect(open.calls).toEqual([]);
        expect(second.error).toMatch(/not requested: export\.arxiv\.org asked us to wait/);
    });
});

