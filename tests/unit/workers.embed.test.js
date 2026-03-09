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
        const result = await processEmbedJob(makeJob());
        expect(result).toEqual(mockResult);
    });

    it('propagates errors so BullMQ can retry the job', async () => {
        embedPost.mockRejectedValue(new Error('Python service unavailable'));
        await expect(processEmbedJob(makeJob())).rejects.toThrow('Python service unavailable');
    });
});
