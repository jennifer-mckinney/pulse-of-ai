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

// The DPIA gate is open for these tests (spec §20); gate-closed refusal is below.
const OPEN = { CORRELATION_DPIA_REF: 'DPIA-2026-01', CORRELATION_ENABLED: 'true', CORRELATION_SALT: 's' };

describe('processCorrelateJob()', () => {
    it('calls correlateUser with sourceId, signalHash, topicAffinity, confidence', async () => {
        const job = makeJob();
        await processCorrelateJob(job, { env: OPEN });

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
        const result = await processCorrelateJob(makeJob(), { env: OPEN });
        expect(result).toMatchObject({ pseudoId: 'agile-fox', isNew: true });
    });

    it('returns null result when correlateUser returns null (low confidence)', async () => {
        correlateUser.mockResolvedValue(null);
        const result = await processCorrelateJob(makeJob({ confidence: 0.50 }), { env: OPEN });
        expect(result).toMatchObject({ correlated: false });
    });

    it('propagates errors so BullMQ can retry', async () => {
        correlateUser.mockRejectedValue(new Error('DB connection lost'));
        await expect(processCorrelateJob(makeJob(), { env: OPEN })).rejects.toThrow('DB connection lost');
    });
});

describe('the DPIA gate (spec §20)', () => {
    const { correlationStatus } = require('../../src/pipeline/correlation-gate');

    it('is off until a DPIA is recorded, the operator enables it and a salt is set', () => {
        expect(correlationStatus({})).toMatchObject({ enabled: false, status: 'awaiting_dpia' });
        expect(correlationStatus({ CORRELATION_DPIA_REF: 'D' })).toMatchObject({ enabled: false, status: 'disabled' });
        expect(correlationStatus({ CORRELATION_DPIA_REF: 'D', CORRELATION_ENABLED: 'true' })).toMatchObject({ status: 'misconfigured' });
        expect(correlationStatus(OPEN)).toMatchObject({ enabled: true, status: 'enabled' });
    });

    it('a correlate job reaching the worker with the gate closed is refused, never processed', async () => {
        const r = await processCorrelateJob(makeJob(), { env: {} });
        expect(r).toMatchObject({ correlated: false, refused: 'awaiting_dpia' });
        expect(correlateUser).not.toHaveBeenCalled();
    });
});
