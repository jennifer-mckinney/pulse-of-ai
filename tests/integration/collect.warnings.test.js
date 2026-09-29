// tests/integration/collect.warnings.test.js — G10-6: a failing or refused
// feed of a multi-feed source is no longer swallowed. It reaches the run's
// errors, last_error and its classification; a per-feed refusal puts the
// source in the refused state (F10-5); when every feed fails, the thrown
// error keeps the most significant classification.

'use strict';

const { dbGet } = require('../../src/db/connection');
const { runCollection } = require('../../src/collectors/runner');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>OWID</title>
<entry><id>https://ourworldindata.org/ai-1</id><title>Artificial intelligence training compute</title>
<link href="https://ourworldindata.org/ai-1"/><updated>${RECORDED_AT}</updated>
<summary>How machine learning compute has grown.</summary></entry></feed>`;
const ROBOTS = ['https://ourworldindata.org/robots.txt', { status: 200, body: 'User-agent: *\nAllow: /\n' }];
const FEED1 = ['https://ourworldindata.org/atom.xml', { status: 200, body: ATOM, headers: { 'content-type': 'application/atom+xml' } }];
const feed2 = res => ['https://ourworldindata.org/atom-data-insights.xml', res];

async function collect(routes) {
    const summary = await runCollection({
        slugs: ['owid'], triggeredBy: 'test', env: TEST_ENV, transport: fixtureTransport(routes),
        now: () => Date.parse(RECORDED_AT),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
        collectorCtx: { sleep: () => Promise.resolve() },
    });
    return summary.sources[0];
}
const stateOf = () => dbGet(`SELECT s.* FROM source_collection_state s JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = 'owid'`);

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('per-feed warnings (G10-6)', () => {
    it('one broken feed: the run still succeeds, and the broken feed is in last_error with its classification', async () => {
        const row = await collect([ROBOTS, FEED1, feed2({ status: 500, body: 'oops' })]);
        expect(row.outcome).toBe('ok');
        expect(row.kept).toBe(1);
        expect(row.error).toMatch(/atom-data-insights\.xml/);
        expect(row.errorKind).toBe('http_5xx');
        const st = await stateOf();
        expect(st).toMatchObject({ last_error_kind: 'http_5xx', last_http_status: 500, access_denied_at: null });
        expect(st.last_success_at).not.toBeNull();
    });

    it('one feed refused (403): the source enters the refused state', async () => {
        const row = await collect([ROBOTS, FEED1, feed2({ status: 403, body: 'denied' })]);
        expect(row.status).toBe('blocked_by_source');
        expect(row.errorKind).toBe('access_denied');
        expect(await stateOf()).toMatchObject({ access_denied_status: 403, refusal_count: 1 });
    });

    it('every feed fails: the classification survives (a refusal wins over a 5xx)', async () => {
        const row = await collect([ROBOTS, ['https://ourworldindata.org/atom.xml', { status: 500, body: 'x' }], feed2({ status: 451, body: 'legal' })]);
        expect(row.outcome).toBe('error');
        expect(row.errorKind).toBe('access_denied');
        expect(row.httpStatus).toBe(451);
        expect(row.error).toMatch(/atom\.xml.*; .*atom-data-insights\.xml/);
    });

    it('every feed 5xx: http_5xx, not internal', async () => {
        const row = await collect([ROBOTS, ['https://ourworldindata.org/atom.xml', { status: 502, body: 'x' }], feed2({ status: 503, body: 'x' })]);
        expect(row).toMatchObject({ outcome: 'error', errorKind: 'http_5xx', httpStatus: 502 });
    });
});
