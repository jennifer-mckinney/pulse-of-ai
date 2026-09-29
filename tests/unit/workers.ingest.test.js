// tests/unit/workers.ingest.test.js
// src/workers/ingest.worker.js — the scoring RETRY path. It re-scores a
// stored post under the CURRENT methodology versions (scorePost is
// idempotent), then applies the reachable relevance embed gate
// (one lexicon match, relevance@1.1.0). Pipeline and queues are mocked.

'use strict';

jest.mock('../../src/queues/index', () => ({
    embedQueue: { add: jest.fn().mockResolvedValue({ id: 'embed-job-1' }) },
}));
jest.mock('../../src/pipeline/ingest', () => ({ scorePost: jest.fn() }));
jest.mock('../../src/pipeline/methodology', () => ({
    resolveCurrentMethodology: jest.fn().mockResolvedValue({ sentimentMvId: 's', relevanceMvId: 'r', discourseMvId: 'd' }),
}));

const { scorePost } = require('../../src/pipeline/ingest');
const { embedQueue } = require('../../src/queues/index');
const { resolveCurrentMethodology } = require('../../src/pipeline/methodology');
const { processIngestJob, RELEVANCE_EMBED_THRESHOLD } = require('../../src/workers/ingest.worker');
const { EMBED_GATE_MIN_SCORE, computeRelevance } = require('../../src/pipeline/relevance');

const job = (data = {}) => ({ data: { rawPostId: 'post-1', sourceId: 'src-1', jobId: 'job-1', ...data } });

beforeEach(() => jest.clearAllMocks());

test('the ingest worker imports only functions that exist (the saveProcessedPost defect)', () => {
    const real = jest.requireActual('../../src/pipeline/ingest');
    expect(typeof real.scorePost).toBe('function');
    expect(real.saveProcessedPost).toBeUndefined();
});

test('scores the post with the current methodology ids and the job id', async () => {
    scorePost.mockResolvedValue({ relevance: { score: '0.05' } });
    await processIngestJob(job());
    expect(resolveCurrentMethodology).toHaveBeenCalled();
    expect(scorePost).toHaveBeenCalledWith('post-1', 'job-1', { sentimentMvId: 's', relevanceMvId: 'r', discourseMvId: 'd' });
});

test('one keyword match passes the embed gate → an embed job is queued', async () => {
    const one = computeRelevance('A machine learning paper.');
    scorePost.mockResolvedValue({ relevance: { score: String(one.score) } });
    const r = await processIngestJob(job());
    expect(r).toEqual({ rawPostId: 'post-1', relevance: 0.05, embedJobId: 'embed-job-1' });
    expect(embedQueue.add).toHaveBeenCalledWith('embed-post', { rawPostId: 'post-1' });
});

test('no keyword match → no embed job', async () => {
    scorePost.mockResolvedValue({ relevance: { score: '0' } });
    const r = await processIngestJob(job());
    expect(r.embedJobId).toBeNull();
    expect(embedQueue.add).not.toHaveBeenCalled();
});

test('the gate is reachable: 1/20, not the old 0.40', () => {
    expect(RELEVANCE_EMBED_THRESHOLD).toBe(EMBED_GATE_MIN_SCORE);
    expect(RELEVANCE_EMBED_THRESHOLD).toBe(0.05);
});

test('errors propagate so BullMQ retries; malformed jobs are rejected', async () => {
    scorePost.mockRejectedValue(new Error('db down'));
    await expect(processIngestJob(job())).rejects.toThrow('db down');
    await expect(processIngestJob({ data: { rawPostId: 'x' } })).rejects.toThrow(/rawPostId and jobId/);
});
