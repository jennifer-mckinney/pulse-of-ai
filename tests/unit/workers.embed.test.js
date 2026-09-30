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

    it('a post purged or blanked after the job was queued: completes as a no-op, reason kept, no correlation', async () => {
        for (const reason of ['purged_demo', 'text_removed']) {
            const skip = { postId: 'post-uuid-abc', skipped: true, reason, at: '2026-09-29T10:00:00.000Z' };
            embedPost.mockResolvedValue(skip);
            const OPEN = { CORRELATION_DPIA_REF: 'DPIA-1', CORRELATION_ENABLED: 'true', CORRELATION_SALT: 'embed-test-deployment-salt-01' };
            const r = await processEmbedJob(makeJob(), { env: OPEN });
            expect(r).toEqual({ ...skip, correlation: { queued: false, status: 'skipped' } });
        }
    });

    it('a genuinely missing post still fails the job loudly', async () => {
        embedPost.mockRejectedValue(new Error('Post not found: post-uuid-abc'));
        await expect(processEmbedJob(makeJob())).rejects.toThrow('Post not found: post-uuid-abc');
    });

    it('propagates errors so BullMQ can retry the job', async () => {
        embedPost.mockRejectedValue(new Error('Python service unavailable'));
        await expect(processEmbedJob(makeJob())).rejects.toThrow('Python service unavailable');
    });
});

describe('correlation is never enqueued after the embedding (spec §20; PR #22 grumpy M7)', () => {
    const OPEN = { CORRELATION_DPIA_REF: 'DPIA-1', CORRELATION_ENABLED: 'true', CORRELATION_SALT: 'embed-test-deployment-salt-01' };

    it('reports the gate status at every step and queues nothing, even with every switch set', async () => {
        embedPost.mockResolvedValue({ postId: 'p', embeddingId: 'e', dimensions: 384 });
        const seen = [];
        for (const env of [{}, { CORRELATION_DPIA_REF: 'D' }, { CORRELATION_DPIA_REF: 'D', CORRELATION_ENABLED: 'true' }, OPEN]) {
            seen.push((await processEmbedJob(makeJob(), { env })).correlation);
        }
        expect(seen).toEqual([
            { queued: false, status: 'awaiting_dpia' },
            { queued: false, status: 'disabled' },
            { queued: false, status: 'misconfigured' },
            { queued: false, status: 'not_implemented' },
        ]);
    });

    it('the worker exposes no signal builder or enqueue hook to inject around the gate', () => {
        expect(Object.keys(require('../../src/workers/embed.worker'))).toEqual(['processEmbedJob']);
    });
});
