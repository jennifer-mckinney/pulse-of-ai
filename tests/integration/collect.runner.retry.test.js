// tests/integration/collect.runner.retry.test.js
// When inline scoring of a stored post fails, the runner queues an `ingest`
// retry for it (src/workers/ingest.worker.js) instead of losing the post,
// and the job still completes. scorePost is mocked to fail; everything else
// is real (test DB, fixtures).

'use strict';

jest.mock('../../src/pipeline/ingest', () => {
    const actual = jest.requireActual('../../src/pipeline/ingest');
    return { ...actual, scorePost: jest.fn().mockRejectedValue(new Error('transient DB error')) };
});

const { dbGet } = require('../../src/db/connection');
const { runCollection } = require('../../src/collectors/runner');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

it('queues one ingest retry per stored-but-unscored post; bias and embeds skip them', async () => {
    const queues = { enqueueEmbeds: jest.fn(), enqueueIngestRetry: jest.fn().mockResolvedValue() };
    const s = await runCollection({
        slugs: ['hacker_news'], triggeredBy: 'test', env: TEST_ENV, queues, now: () => Date.parse(RECORDED_AT),
        transport: fixtureTransport([[/hn\.algolia\.com/, 'recorded/hn-algolia.json']]),
    });
    const stored = await dbGet('SELECT COUNT(*)::int AS n FROM raw_posts');
    expect(stored.n).toBeGreaterThan(0);
    expect(s.scoringRetries).toBe(stored.n);
    expect(queues.enqueueIngestRetry).toHaveBeenCalledTimes(stored.n);
    // Each retry holds a slot on its job (Copilot 4129565673).
    expect(queues.enqueueIngestRetry.mock.calls[0][0]).toEqual({ rawPostId: expect.any(String), sourceId: expect.any(String), jobId: s.jobId, reserved: true });
    expect(s.postsProcessed).toBe(0);
    expect(s.bias).toBeNull();
    expect(queues.enqueueEmbeds).not.toHaveBeenCalled();
    // The job waits for its retries before its bias checks and completion.
    const job = await dbGet('SELECT status, inflight_runs FROM processing_jobs WHERE id = $1', [s.jobId]);
    expect(job).toEqual({ status: 'awaiting_retries', inflight_runs: stored.n });
    expect(s.awaitingRetries).toBe(true);
});
