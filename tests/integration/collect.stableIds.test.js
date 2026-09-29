// tests/integration/collect.stableIds.test.js — G10-14: an updated Docker
// Hub repository (new last_updated) is the SAME post, not a new one.

'use strict';

const fs = require('fs');
const path = require('path');
const { dbGet, dbRun } = require('../../src/db/connection');
const { runCollection } = require('../../src/collectors/runner');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV, FIXTURE_ROOT } = require('../helpers/fixtureTransport');

const body = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'recorded/dockerhub-ai.json'), 'utf8'));
const run = (json) => runCollection({
    slugs: ['docker_hub'], triggeredBy: 'test', env: TEST_ENV, now: () => Date.parse(RECORDED_AT),
    transport: fixtureTransport([['https://hub.docker.com/v2/namespaces/ai/repositories', { status: 200, body: JSON.stringify(json), headers: { 'content-type': 'application/json' } }]]),
    queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
    collectorCtx: { sleep: () => Promise.resolve() },
});
const count = async () => (await dbGet(`SELECT COUNT(*)::int AS n FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id WHERE ds.name = 'docker_hub'`)).n;

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

it('a repository pushed again (new last_updated) dedups to its stored post', async () => {
    const first = await run(body);
    const n = await count();
    expect(n).toBe(first.sources[0].new);
    expect(n).toBeGreaterThan(0);
    await dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'`);
    const bumped = { ...body, results: body.results.map(r => ({ ...r, last_updated: new Date(Date.parse(RECORDED_AT) - 60000).toISOString() })) };
    const second = await run(bumped);
    expect(second.sources[0]).toMatchObject({ outcome: 'ok', new: 0 });
    expect(await count()).toBe(n);
});
