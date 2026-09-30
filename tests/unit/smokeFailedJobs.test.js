// tests/unit/smokeFailedJobs.test.js
// The standup smoke check requires 0 failed BullMQ jobs on every queue
// /api/health reports (an embed job whose post was purged or blanked
// completes as a no-op, so any failed job is a real error). Counts that
// could not be read are never taken as 0.

'use strict';

const { failedJobsVerdict } = require('../../scripts/smoke-check');

describe('failedJobsVerdict', () => {
    test('passes when every queue has 0 failed jobs', () => {
        expect(failedJobsVerdict({
            embed: { waiting: 3, active: 1, delayed: 0, failed: 0 },
            ingest: { waiting: 0, active: 0, delayed: 0, failed: 0 },
        })).toEqual({ ok: true, detail: '0 failed jobs on 2 queues' });
    });

    test('names each queue with failed jobs', () => {
        expect(failedJobsVerdict({
            embed: { failed: 9 }, ingest: { failed: 0 }, correlate: { failed: 2 },
        })).toEqual({ ok: false, detail: 'embed: 9 failed, correlate: 2 failed' });
    });

    test('unreadable counts are not a pass', () => {
        for (const q of [null, undefined, 'x']) {
            const v = failedJobsVerdict(q);
            expect(v.ok).toBe(false);
            expect(v.detail).toMatch(/queue counts unavailable/);
        }
    });
});
