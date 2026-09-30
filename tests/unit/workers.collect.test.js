// tests/unit/workers.collect.test.js
// src/workers/collect.worker.js — the collect.* queue consumer runs one
// registry source through the runner and returns a compact summary.

'use strict';

jest.mock('../../src/collectors/runner', () => ({ runCollection: jest.fn() }));

const { runCollection } = require('../../src/collectors/runner');
const { processCollectJob } = require('../../src/workers/collect.worker');

test('runs exactly the job\'s source as a cron job and summarises the outcome', async () => {
    runCollection.mockResolvedValue({
        jobId: 'j1', postsProcessed: 3, embedQueued: 2,
        sources: [{ slug: 'npr', status: 'collecting', outcome: 'ok', fetched: 10, kept: 4, error: null }],
    });
    const r = await processCollectJob({ data: { slug: 'npr' } }, { transport: 't' });
    // P10-12: scoring is queued to `ingest` jobs (scoreVia 'queue').
    expect(runCollection).toHaveBeenCalledWith({ cycle: { windowMs: 150000 }, scoreVia: 'queue', transport: 't', slugs: ['npr'], triggeredBy: 'cron' });
    expect(r).toEqual({ slug: 'npr', jobId: 'j1', status: 'collecting', outcome: 'ok', fetched: 10, kept: 4,
        newPosts: 3, queuedForScoring: 0, embedQueued: 2, error: null, reason: null });
});

test('a skipped source reports its reason; a job without a slug fails', async () => {
    runCollection.mockResolvedValue({ jobId: 'j2', postsProcessed: 0, embedQueued: 0,
        sources: [{ slug: 'npr', status: 'collecting', outcome: 'skipped', reason: 'collected within its poll interval (rate limit)' }] });
    expect((await processCollectJob({ data: { slug: 'npr' } })).reason).toMatch(/poll interval/);
    await expect(processCollectJob({ data: {} })).rejects.toThrow(/slug/);
});
