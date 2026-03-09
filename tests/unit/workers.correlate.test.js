// tests/unit/workers.correlate.test.js
// TDD tests for src/workers/correlate.worker.js

'use strict';

jest.mock('../../src/queues/index', () => ({
    connection: { host: '127.0.0.1', port: 6379 },
}));

jest.mock('../../src/pipeline/correlation', () => ({
    correlateUser:             jest.fn(),
    computeSignalHash:         jest.fn(),
    CORRELATION_MIN_CONFIDENCE: 0.85,
}));

const { correlateUser, computeSignalHash } = require('../../src/pipeline/correlation');
const { processCorrelateJob } = require('../../src/workers/correlate.worker');

function makeJob(overrides = {}) {
    return {
        data: {
            rawPostId:     'post-uuid-xyz',
            sourceId:      'src-uuid-123',
            signalHash:    'hash-abc',
            topicAffinity: ['ai', 'ethics'],
            confidence:    0.91,
            ...overrides,
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    correlateUser.mockResolvedValue({ pseudoUserId: 'pu-1', pseudoId: 'agile-fox', isNew: true });
    computeSignalHash.mockReturnValue('derived-hash-abc');
});

describe('processCorrelateJob()', () => {
    it('calls correlateUser with sourceId, signalHash, topicAffinity, confidence', async () => {
        const job = makeJob();
        await processCorrelateJob(job);

        expect(correlateUser).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceId:      job.data.sourceId,
                signalHash:    job.data.signalHash,
                topicAffinity: job.data.topicAffinity,
                confidence:    job.data.confidence,
            }),
        );
    });

    it('returns the result from correlateUser', async () => {
        const result = await processCorrelateJob(makeJob());
        expect(result).toMatchObject({ pseudoId: 'agile-fox', isNew: true });
    });

    it('returns null result when correlateUser returns null (low confidence)', async () => {
        correlateUser.mockResolvedValue(null);
        const result = await processCorrelateJob(makeJob({ confidence: 0.50 }));
        expect(result).toMatchObject({ correlated: false });
    });

    it('propagates errors so BullMQ can retry', async () => {
        correlateUser.mockRejectedValue(new Error('DB connection lost'));
        await expect(processCorrelateJob(makeJob())).rejects.toThrow('DB connection lost');
    });
});
