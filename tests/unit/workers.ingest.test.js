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
// G10-2: the retry joins the post's cycle while it runs, else the current one.
jest.mock('../../src/collectors/cycle', () => ({
    retryJobFor: jest.fn(async id => ({ jobId: id, joined: true })),
    releaseRetry: jest.fn().mockResolvedValue(),
    leaveCycle: jest.fn().mockResolvedValue(),
}));
jest.mock('../../src/pipeline/methodology', () => ({
    resolveCurrentMethodology: jest.fn().mockResolvedValue({ sentimentMvId: 's', relevanceMvId: 'r', discourseMvId: 'd' }),
}));

const { scorePost } = require('../../src/pipeline/ingest');
const { embedQueue } = require('../../src/queues/index');
const { resolveCurrentMethodology } = require('../../src/pipeline/methodology');
const { processIngestJob, RELEVANCE_EMBED_THRESHOLD } = require('../../src/workers/ingest.worker');
const { EMBED_GATE_MIN_SCORE, computeRelevance } = require('../../src/pipeline/relevance');

const job = (data = {}) => ({ data: { rawPostId: 'post-1', sourceId: 'src-1', jobId: 'job-1', ...data } });

const cycle = require('../../src/collectors/cycle');

beforeEach(() => jest.clearAllMocks());

test('G10-2: a retry for a running refresh job stays with it (no cycle joined or left)', async () => {
    cycle.retryJobFor.mockResolvedValueOnce({ jobId: 'refresh-job', joined: false });
    scorePost.mockResolvedValueOnce({ relevance: { score: '0' } });
    await processIngestJob(job({ jobId: 'refresh-job' }));
    expect(scorePost).toHaveBeenCalledWith('post-1', 'refresh-job', expect.any(Object));
    expect(cycle.leaveCycle).not.toHaveBeenCalled();
});

test('G10-2: a retry against a closed job scores under the current cycle, and always leaves it', async () => {
    cycle.retryJobFor.mockResolvedValueOnce({ jobId: 'cycle-now', joined: true });
    scorePost.mockRejectedValueOnce(new Error('db blip'));
    await expect(processIngestJob(job())).rejects.toThrow('db blip');
    expect(cycle.retryJobFor).toHaveBeenCalledWith('job-1', expect.any(Number));
    expect(scorePost).toHaveBeenCalledWith('post-1', 'cycle-now', expect.any(Object));
    expect(cycle.leaveCycle).toHaveBeenCalledWith('cycle-now', {});
});

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
    expect(r).toEqual({ rawPostId: 'post-1', relevance: 1 / 21, embedJobId: 'embed-job-1' });
    expect(embedQueue.add).toHaveBeenCalledWith('embed-post', { rawPostId: 'post-1' }, { jobId: 'embed-post-1' });   // P1-5: deterministic id
});

test('no keyword match → no embed job', async () => {
    scorePost.mockResolvedValue({ relevance: { score: '0' } });
    const r = await processIngestJob(job());
    expect(r.embedJobId).toBeNull();
    expect(embedQueue.add).not.toHaveBeenCalled();
});

test('the gate is reachable: one term of relevance@1.2.0\'s 21 (1/21), not the old 0.40', () => {
    expect(RELEVANCE_EMBED_THRESHOLD).toBe(EMBED_GATE_MIN_SCORE);
    expect(RELEVANCE_EMBED_THRESHOLD).toBe(1 / 21);
});

test('errors propagate so BullMQ retries; malformed jobs are rejected', async () => {
    scorePost.mockRejectedValue(new Error('db down'));
    await expect(processIngestJob(job())).rejects.toThrow('db down');
    await expect(processIngestJob({ data: { jobId: 'j' } })).rejects.toThrow(/needs rawPostId/);
    // G10-4: a sweep re-queue has no job id — it scores under the current cycle.
    scorePost.mockResolvedValue({ relevance: { score: '0' } });
    cycle.retryJobFor.mockResolvedValueOnce({ jobId: 'cycle-now', joined: true });
    await processIngestJob({ data: { rawPostId: 'x', jobId: null } });
    expect(cycle.retryJobFor).toHaveBeenLastCalledWith(null, expect.any(Number));
    expect(scorePost).toHaveBeenLastCalledWith('x', 'cycle-now', expect.any(Object));
});
