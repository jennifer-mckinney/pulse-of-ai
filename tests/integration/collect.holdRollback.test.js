// tests/integration/collect.holdRollback.test.js
// Copilot re-review #44: G10-5 rolls a route's cursor and HTTP validators
// back when any of its items fails to store, so the next run fetches them
// again. On a multi-feed RSS route, one feed can answer 429 (a hold) while
// another returns items; a store failure must roll back the validators but
// KEEP the newly learned hold, or a restarted worker / another replica would
// ask the held feed again before the source's time.
//
// PR #45 merge: the hold lives in the ONE rate-limit store
// (source_collection_state.rate_limited_hosts, saved by state.saveHolds),
// never in the HTTP cache the rollback restores — so it cannot be rolled
// back at all.

'use strict';

const { dbGet, dbRun } = require('../../src/db/connection');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

let mockFailStores = 0;
jest.mock('../../src/pipeline/ingest', () => {
    const real = jest.requireActual('../../src/pipeline/ingest');
    return {
        ...real,
        storeRawPost: async (...a) => {
            if (mockFailStores > 0) { mockFailStores--; throw new Error('db blip'); }
            return real.storeRawPost(...a);
        },
    };
});
const { runCollection } = require('../../src/collectors/runner');

// owid's route reads atom.xml first, then atom-data-insights.xml (same host).
const OPEN = 'https://ourworldindata.org/atom.xml';
const HELD = 'https://ourworldindata.org/atom-data-insights.xml';
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>OWID</title>
<item><title>Artificial intelligence and machine learning compute</title><link>https://ourworldindata.org/ai-compute</link>
<guid>https://ourworldindata.org/ai-compute</guid><pubDate>${new Date(RECORDED_AT).toUTCString()}</pubDate>
<description>How AI training compute has grown.</description></item></channel></rss>`;

const run = (transport) => runCollection({
    slugs: ['owid'], triggeredBy: 'test', env: TEST_ENV, transport, now: () => Date.parse(RECORDED_AT),
    queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
    collectorCtx: { sleep: () => Promise.resolve() },
});
const nextPoll = () => dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'
    WHERE source_id = (SELECT id FROM data_sources WHERE name = 'owid')`);
const stateOf = () => dbGet(`SELECT s.http_cache, s.rate_limited_hosts FROM source_collection_state s
    JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = 'owid'`);

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

it('a store failure rolls back the validators but keeps a hold learned in the same route', async () => {
    // Run 1: the first feed returns an item (and an ETag), the second answers
    // 429 — the host is held; storing the item fails → G10-5 rollback.
    mockFailStores = 1;
    const s = await run(fixtureTransport([
        [OPEN, { body: RSS, headers: { etag: '"open-v1"', 'content-type': 'application/rss+xml' } }],
        [HELD, { status: 429, headers: { 'retry-after': '3600' } }],
    ]));
    expect(s.sources[0]).toMatchObject({ outcome: 'error', kept: 1, new: 0 });
    const st = await stateOf();
    expect(st.http_cache[OPEN]).toBeUndefined();            // validator rolled back: the item is fetched again
    expect(Object.keys(st.http_cache).filter(k => k.startsWith('retry-after:'))).toEqual([]);
    expect(st.rate_limited_hosts['ourworldindata.org']).toMatchObject({ http_status: 429, signal: 'http_429' });
    expect(Date.parse(st.rate_limited_hosts['ourworldindata.org'].until)).toBeGreaterThan(Date.now() + 3500 * 1000);

    // Run 2, a fresh client (restart / another replica): the persisted host
    // hold survived the rollback, so the source is not asked at all.
    await nextPoll();
    const held = fixtureTransport([[/./, { body: RSS }]]);
    await run(held);
    expect(held.calls).toEqual([]);

    // Run 3, after the source's time: the item is fetched again WITHOUT the
    // rolled-back validator, and stored.
    await dbRun(`UPDATE source_collection_state
        SET rate_limited_hosts = jsonb_set(rate_limited_hosts, '{ourworldindata.org,until}', to_jsonb('2000-01-01T00:00:00.000Z'::text)),
            rate_limited_until = NULL
        WHERE source_id = (SELECT id FROM data_sources WHERE name = 'owid')`);
    await nextPoll();
    const open = fixtureTransport([[OPEN, { body: RSS }], [HELD, { body: RSS }]]);
    const again = await run(open);
    const first = open.calls.find(c => c.url === OPEN);
    expect(first.headers['If-None-Match']).toBeUndefined();
    expect(again.sources[0].new).toBe(1);
});
