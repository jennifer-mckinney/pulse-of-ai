// tests/unit/workers.correlate.test.js
// src/workers/correlate.worker.js: cross-platform correlation is NOT
// IMPLEMENTED (PR #22 grumpy M7). Every job is refused with the DPIA gate's
// status and reason — whatever the env and whatever the job claims. The real
// gate and the real correlation module are used: nothing is mocked past the
// refusal.

'use strict';

const { processCorrelateJob } = require('../../src/workers/correlate.worker');
const { correlationStatus, NOT_IMPLEMENTED_REASON } = require('../../src/pipeline/correlation-gate');

const SALT = 'correlate-test-deployment-salt-9b2e';
const OPEN = { CORRELATION_DPIA_REF: 'DPIA-2026-01', CORRELATION_ENABLED: 'true', CORRELATION_SALT: SALT };

function makeJob(overrides = {}) {
    return {
        data: {
            rawPostId: 'post-uuid-xyz', sourceId: 'src-uuid-123', signalHash: 'hash-abc',
            topicAffinity: ['ai', 'ethics'], confidence: 0.99, ...overrides,
        },
    };
}

describe('the DPIA gate (spec §20) and M7', () => {
    it('is off at every step, and with every switch set it is not_implemented — never enabled', () => {
        expect(correlationStatus({})).toMatchObject({ enabled: false, status: 'awaiting_dpia' });
        expect(correlationStatus({ CORRELATION_DPIA_REF: 'D' })).toMatchObject({ enabled: false, status: 'disabled' });
        expect(correlationStatus({ CORRELATION_DPIA_REF: 'D', CORRELATION_ENABLED: 'true' })).toMatchObject({ enabled: false, status: 'misconfigured' });
        const st = correlationStatus(OPEN);
        expect(st).toEqual({ enabled: false, status: 'not_implemented', reason: expect.stringContaining(NOT_IMPLEMENTED_REASON) });
        expect(st.reason).toMatch(/^not implemented: signal design pending DPIA/);
        expect(st.reason).toMatch(/DPIA-2026-01 recorded/);
        for (const v of ['true', '1', 'yes', 'on', 'TRUE']) {
            expect(correlationStatus({ ...OPEN, CORRELATION_ENABLED: v }).enabled).toBe(false);
        }
    });
});

describe('processCorrelateJob()', () => {
    it.each([
        ['no env', {}, 'awaiting_dpia'],
        ['DPIA only', { CORRELATION_DPIA_REF: 'D' }, 'disabled'],
        ['no salt', { CORRELATION_DPIA_REF: 'D', CORRELATION_ENABLED: 'true' }, 'misconfigured'],
        ['every switch set', OPEN, 'not_implemented'],
    ])('%s: refused with the gate status and reason', async (_label, env, status) => {
        const r = await processCorrelateJob(makeJob(), { env });
        expect(r).toEqual({ correlated: false, refused: status, reason: correlationStatus(env).reason });
    });

    it('a job claiming full confidence is still refused (no threshold path exists)', async () => {
        const r = await processCorrelateJob(makeJob({ confidence: 1 }), { env: OPEN });
        expect(r).toMatchObject({ correlated: false, refused: 'not_implemented' });
    });
});
