// tests/integration/maintenance.visibility.test.js
// PR #22 principal P0-1 / grumpy #6: retention failures are never silent.
//   - a failing maintenance step fails the job and is recorded in
//     maintenance_state (last_failed_at, last_error); a clean run records
//     last_ok_at and keeps the last failure time;
//   - text held past its window (+ grace) opens ONE critical
//     retention_overdue alert per source, resolved with an audited
//     alert_resolutions record once the text is gone;
//   - /api/health reports both.

'use strict';

const request = require('supertest');
const db = require('../../src/db/connection');
const app = require('../../src/server');
const { seedSources } = require('../../scripts/seed');
const { processMaintenanceJob } = require('../../src/workers/maintenance.worker');
const overdue = require('../../src/collectors/retention-overdue');
const retention = require('../../src/collectors/retention');
const { insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

const HOUR = 3600000;

describe('maintenance runs are recorded; a failed step fails the job', () => {
    it('records last_failed_at / last_error on failure, last_ok_at on success', async () => {
        const err = await processMaintenanceJob({ data: { task: 'retention' } }, { steps: [
            ['retention', async () => { throw new Error('lock timeout'); }],
            ['stale_jobs', async () => 0],
        ] }).catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/retention \(lock timeout\)/);
        let row = await db.dbGet('SELECT * FROM maintenance_state WHERE task = $1', ['retention']);
        expect(row.last_ok_at).toBeNull();
        expect(row.last_failed_at).not.toBeNull();
        expect(row.last_error).toBe('retention: lock timeout');
        expect(row.last_steps).toEqual({ retention: { ok: false, error: 'lock timeout' }, stale_jobs: { ok: true } });

        await expect(processMaintenanceJob({ data: { task: 'retention' } }, { steps: [['retention', async () => 1]] }))
            .resolves.toEqual({ retention: { ok: true, result: 1 } });
        row = await db.dbGet('SELECT * FROM maintenance_state WHERE task = $1', ['retention']);
        expect(row.last_ok_at).not.toBeNull();
        expect(row.last_failed_at).not.toBeNull();
        expect(row.last_error).toBeNull();
    });

    it('logs a failing step at error level', async () => {
        const errors = [];
        await processMaintenanceJob({ data: { task: 'daily' } }, {
            steps: [['compaction', async () => { throw new Error('x'); }]], logError: m => errors.push(m),
        }).catch(() => {});
        expect(errors).toEqual(['[maintenance] daily/compaction failed: x']);
    });
});

describe('retention_overdue', () => {
    let ids; let mv; let jobId;
    beforeEach(async () => {
        await seedSources();
        ids = Object.fromEntries((await db.dbAll("SELECT id, name FROM data_sources WHERE name IN ('reddit', 'npr')")).map(r => [r.name, r.id]));
        mv = await insertMethodologyVersions();
        jobId = await insertJob();
    });
    const post = (slug, hoursAgo, ext) => insertPostWithFullPipeline(ids[slug], jobId, mv, {
        externalId: ext, collectedAt: new Date(Date.now() - hoursAgo * HOUR), location: '' });

    it('opens one critical alert per overdue source, never twice, and resolves it with an audit record', async () => {
        const late = await post('reddit', 72, 'r-late');      // 48 h window + 1 h grace: overdue
        await post('reddit', 47, 'r-live');                    // inside the window
        await post('npr', 24 * 30, 'n-live');                  // 90-day detail window: fine

        const first = await overdue.evaluateRetentionOverdue();
        expect(first.opened).toEqual(['reddit']);
        expect(first.overdue).toEqual([expect.objectContaining({ slug: 'reddit', posts: 1, window_hours: 48 })]);
        expect((await overdue.evaluateRetentionOverdue()).opened).toEqual([]);
        const open = await db.dbAll("SELECT severity, details FROM alert_events WHERE alert_type = 'retention_overdue' AND resolved_at IS NULL");
        expect(open).toHaveLength(1);
        expect(open[0].severity).toBe('critical');
        expect(open[0].details).toMatchObject({ slug: 'reddit', posts: 1 });

        const health = await request(app).get('/api/health');
        expect(health.body.maintenance.retention_overdue).toMatchObject({ posts: 1, sources: [{ slug: 'reddit', posts: 1 }] });
        expect(health.body.active_alerts.map(a => a.alert_type)).toContain('retention_overdue');

        await retention.blankPosts('reddit', [late], { reason: 'test' });
        const after = await overdue.evaluateRetentionOverdue();
        expect(after.resolved).toEqual(['reddit']);
        const closed = await db.dbGet(
            `SELECT ar.resolved_by FROM alert_events ae JOIN alert_resolutions ar ON ar.alert_id = ae.id
             WHERE ae.alert_type = 'retention_overdue' AND ae.resolved_at IS NOT NULL`);
        expect(closed.resolved_by).toMatch(/retention-overdue evaluator/);
    });

    // Docs audit round 4: web's process env decides /api/health's
    // retention_overdue (compose now passes RETENTION_OVERDUE_GRACE_MINUTES to
    // web), and the watchdog's retention_overdue condition reads that report.
    describe('a non-default RETENTION_OVERDUE_GRACE_MINUTES on web', () => {
        const saved = process.env.RETENTION_OVERDUE_GRACE_MINUTES;
        afterEach(() => {
            if (saved === undefined) delete process.env.RETENTION_OVERDUE_GRACE_MINUTES;
            else process.env.RETENTION_OVERDUE_GRACE_MINUTES = saved;
        });
        const { evaluate } = require('../../src/watchdog/conditions');
        const { readConfig } = require('../../src/watchdog/config');
        const watchdogSees = (health) => evaluate(
            { health, httpStatus: 200, fetchError: null, dbReachable: true },
            { now: new Date(), thresholds: readConfig({}).thresholds },
        ).conditions.map(c => c.condition);

        it('/api/health and the watchdog condition honour it', async () => {
            // 48 h reddit window + 40 min: past a 30 min grace, inside the 60 min default.
            await post('reddit', 48 + 40 / 60, 'r-grace');

            delete process.env.RETENTION_OVERDUE_GRACE_MINUTES;
            let res = await request(app).get('/api/health');
            expect(res.body.maintenance.retention_overdue).toEqual({ posts: 0, sources: [] });
            expect(watchdogSees(res.body)).not.toContain('retention_overdue');

            process.env.RETENTION_OVERDUE_GRACE_MINUTES = '30';
            res = await request(app).get('/api/health');
            expect(res.body.maintenance.retention_overdue).toMatchObject({ posts: 1, sources: [{ slug: 'reddit', posts: 1 }] });
            expect(watchdogSees(res.body)).toContain('retention_overdue');
        });
    });

    it('reports a misconfigured window instead of a fake zero', async () => {
        await expect(overdue.overdueBySource({ env: { RETENTION_DETAIL_DAYS: '0' } })).rejects.toThrow(/RETENTION_DETAIL_DAYS/);
        expect(overdue.graceMinutes({})).toBe(60);
        expect(overdue.graceMinutes({ RETENTION_OVERDUE_GRACE_MINUTES: '5' })).toBe(60);
        expect(overdue.graceMinutes({ RETENTION_OVERDUE_GRACE_MINUTES: '30' })).toBe(30);
    });
});

describe('GET /api/health — maintenance block', () => {
    it('reports the last run per task (null before any run)', async () => {
        let res = await request(app).get('/api/health');
        expect(res.body.maintenance.tasks).toEqual({ retention: null, daily: null, terms: null });
        await processMaintenanceJob({ data: { task: 'daily' } }, { steps: [['compaction', async () => 0]] });
        res = await request(app).get('/api/health');
        expect(res.body.maintenance.tasks.daily).toMatchObject({ last_error: null });
        expect(res.body.maintenance.tasks.daily.last_ok_at).not.toBeNull();
    });
});
