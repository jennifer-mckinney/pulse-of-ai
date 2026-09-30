// tests/unit/workers.embed.test.js
// TDD tests for src/workers/embed.worker.js

'use strict';

jest.mock('../../src/queues/index', () => ({
    connection: { host: '127.0.0.1', port: 6379 },
}));

jest.mock('../../src/pipeline/embeddings', () => ({
    embedPost: jest.fn(),
}));

const { embedPost } = require('../../src/pipeline/embeddings');
const { processEmbedJob } = require('../../src/workers/embed.worker');

function makeJob(overrides = {}) {
    return { data: { rawPostId: 'post-uuid-abc', ...overrides } };
}

beforeEach(() => jest.clearAllMocks());

describe('processEmbedJob()', () => {
    it('calls embedPost with the rawPostId from job data', async () => {
        embedPost.mockResolvedValue({ postId: 'post-uuid-abc', embeddingId: 'emb-1', dimensions: 384 });
        await processEmbedJob(makeJob());
        expect(embedPost).toHaveBeenCalledWith('post-uuid-abc');
    });

    it('returns the result from embedPost', async () => {
        const mockResult = { postId: 'post-uuid-abc', embeddingId: 'emb-1', dimensions: 384 };
        embedPost.mockResolvedValue(mockResult);
        const result = await processEmbedJob(makeJob(), { env: {} });
        // Spec §20: with the DPIA gate closed nothing is queued, and it says so.
        expect(result).toEqual({ ...mockResult, correlation: { queued: false, status: 'awaiting_dpia' } });
    });

    it('propagates errors so BullMQ can retry the job', async () => {
        embedPost.mockRejectedValue(new Error('Python service unavailable'));
        await expect(processEmbedJob(makeJob())).rejects.toThrow('Python service unavailable');
    });
});

describe('correlation trigger after the embedding (spec §20, DPIA-gated)', () => {
    const OPEN = { CORRELATION_DPIA_REF: 'DPIA-1', CORRELATION_ENABLED: 'true', CORRELATION_SALT: 'salt' };

    it('never enqueues a correlate job while the gate is closed', async () => {
        embedPost.mockResolvedValue({ postId: 'p', embeddingId: 'e', dimensions: 384 });
        const enqueueCorrelate = jest.fn();
        for (const env of [{}, { CORRELATION_DPIA_REF: 'D' }, { CORRELATION_DPIA_REF: 'D', CORRELATION_ENABLED: 'true' }]) {
            await processEmbedJob(makeJob(), { env, enqueueCorrelate, buildSignals: jest.fn() });
        }
        expect(enqueueCorrelate).not.toHaveBeenCalled();
    });

    it('with the gate open, enqueues the post-level signals after the embedding is stored', async () => {
        embedPost.mockResolvedValue({ postId: 'p', embeddingId: 'e', dimensions: 384 });
        const signals = { rawPostId: 'post-uuid-abc', sourceId: 's', topicAffinity: ['llm'], signalHash: 'h', confidence: 0 };
        const enqueueCorrelate = jest.fn().mockResolvedValue();
        const buildSignals = jest.fn().mockResolvedValue(signals);
        const r = await processEmbedJob(makeJob(), { env: OPEN, enqueueCorrelate, buildSignals });
        expect(buildSignals).toHaveBeenCalledWith('post-uuid-abc', OPEN);
        expect(enqueueCorrelate).toHaveBeenCalledWith(signals);
        expect(r.correlation).toEqual({ queued: true, status: 'enabled' });
    });
});
