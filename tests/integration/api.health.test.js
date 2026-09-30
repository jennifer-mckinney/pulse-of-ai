// tests/integration/api.health.test.js
// Tests for GET /api/health
// Verifies: 200 response, shape, db_connected flag, last_job, active_alerts.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { insertJob, insertAlert } = require('./helpers');

describe('GET /api/health', () => {
    it('returns 200 with correct shape', async () => {
        const res = await request(app).get('/api/health');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            status:        expect.any(String),
            db_connected:  expect.any(Boolean),
            active_alerts: expect.any(Array),
        });
        // Key must be present even when null — dedicated tests verify the value
        expect(res.body).toHaveProperty('last_job');
    });

    it('reports db_connected as true when database is reachable', async () => {
        const res = await request(app).get('/api/health');
        expect(res.body.db_connected).toBe(true);
        expect(res.body.status).toBe('healthy');
    });

    it('returns last_job as null when no jobs exist', async () => {
        const res = await request(app).get('/api/health');
        expect(res.body.last_job).toBeNull();
    });

    it('returns the most recent processing_jobs row as last_job', async () => {
        await insertJob('completed', { postsProcessed: 12 });
        const jobId = await insertJob('completed', { postsProcessed: 42 });  // most recent

        const res = await request(app).get('/api/health');

        expect(res.body.last_job).toMatchObject({
            id:              jobId,
            status:          'completed',
            posts_processed: 42,
        });
    });

    it('returns empty active_alerts when no unresolved alerts exist', async () => {
        const res = await request(app).get('/api/health');
        expect(res.body.active_alerts).toEqual([]);
    });

    it('returns unresolved alerts in active_alerts', async () => {
        await insertAlert({ alertType: 'location_concentration', severity: 'warning' });

        const res = await request(app).get('/api/health');

        expect(res.body.active_alerts).toHaveLength(1);
        expect(res.body.active_alerts[0]).toMatchObject({
            alert_type: 'location_concentration',
            severity:   'warning',
        });
    });

    it('does not return resolved alerts in active_alerts', async () => {
        const { dbRun } = require('../../src/db/connection');
        const alertId = await insertAlert({ alertType: 'bias_violation', severity: 'warning' });

        // Mark as resolved
        await dbRun(
            'UPDATE alert_events SET resolved_at = NOW() WHERE id = $1',
            [alertId],
        );

        const res = await request(app).get('/api/health');
        expect(res.body.active_alerts).toHaveLength(0);
    });

    it('returns multiple unresolved alerts with correct ordering', async () => {
        await insertAlert({ alertType: 'location_concentration', severity: 'warning' });
        await insertAlert({ alertType: 'bias_violation', severity: 'critical' });

        const res = await request(app).get('/api/health');
        
        expect(res.body.active_alerts.length).toBeGreaterThanOrEqual(2);

        const [a0, a1] = res.body.active_alerts;
        expect(new Date(a0.created_at).getTime())
            .toBeGreaterThanOrEqual(new Date(a1.created_at).getTime());
    });

    // FR-24 contract (PR #8 review): the payload /api/health serves must
    // drive the frontend's shared traffic-light mapping to RED when any
    // unresolved alert is critical, and to yellow for warnings only.
    it('serves alert severities that map critical → red, warning → yellow (FR-24)', async () => {
        const { healthState } = require('../../public/js/utils');

        await insertAlert({ alertType: 'location_concentration', severity: 'warning' });
        let res = await request(app).get('/api/health');
        expect(healthState(res.body).state).toBe('yellow');

        await insertAlert({ alertType: 'bias_violation', severity: 'critical' });
        res = await request(app).get('/api/health');
        expect(res.body.active_alerts.map(a => a.severity).sort())
            .toEqual(['critical', 'warning']);
        expect(healthState(res.body)).toMatchObject({ state: 'red', critical: 1, alerts: 2 });
    });

    it('maps a clean healthy payload to green (FR-24)', async () => {
        const { healthState } = require('../../public/js/utils');
        const res = await request(app).get('/api/health');
        expect(healthState(res.body).state).toBe('green');
    });
});

// P9-7: /api/health reports Redis reachability and worker liveness (the
// worker's heartbeat, src/workers/heartbeat.js). A fake Redis client is
// injected so the suite never depends on — or writes to — a shared Redis.
describe('GET /api/health — redis and worker (P9-7)', () => {
    const health = require('../../src/routes/health');
    const { HEARTBEAT_KEY } = require('../../src/workers/heartbeat');
    beforeEach(() => health._setQueueCountsForTests(async () => ({})));
    afterEach(() => { health._setRedisClientForTests(null); health._setQueueCountsForTests(null); });

    it('reports a reachable Redis and a live worker', async () => {
        const at = new Date().toISOString();
        const get = jest.fn(async () => at);
        health._setRedisClientForTests({ ping: async () => 'PONG', get });
        const res = await request(app).get('/api/health');
        expect(res.body.redis).toEqual({ reachable: true });
        expect(res.body.worker).toMatchObject({ alive: true, last_heartbeat: at });
        expect(get).toHaveBeenCalledWith(HEARTBEAT_KEY);
    });

    it('reports a dead worker when no heartbeat is stored', async () => {
        health._setRedisClientForTests({ ping: async () => 'PONG', get: async () => null });
        const res = await request(app).get('/api/health');
        expect(res.body.worker).toMatchObject({ alive: false, last_heartbeat: null });
    });

    it('P10-8: serves the queue depth of every queue next to the heartbeat; null (never a fake zero) when unreadable', async () => {
        health._setRedisClientForTests({ ping: async () => 'PONG', get: async () => new Date().toISOString() });
        health._setQueueCountsForTests(async () => ({ ingest: { waiting: 7, active: 2, delayed: 0, failed: 1 }, maintenance: { waiting: 1 } }));
        let res = await request(app).get('/api/health');
        expect(Object.keys(res.body.worker.queues)).toEqual(health.QUEUE_NAMES);
        expect(res.body.worker.queues.ingest).toEqual({ waiting: 7, active: 2, delayed: 0, failed: 1 });
        expect(res.body.worker.queues.maintenance).toEqual({ waiting: 1, active: 0, delayed: 0, failed: 0 });
        health._setQueueCountsForTests(async () => { throw new Error('NOAUTH'); });
        res = await request(app).get('/api/health');
        expect(res.body.worker.queues).toBeNull();
        expect(res.body.worker.alive).toBe(true);
    });

    it('reports Redis unreachable (and the worker unknown) without failing the endpoint', async () => {
        health._setRedisClientForTests({
            ping: async () => { throw new Error('ECONNREFUSED'); },
            get: async () => { throw new Error('ECONNREFUSED'); },
        });
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.db_connected).toBe(true);
        expect(res.body.redis).toEqual({ reachable: false });
        expect(res.body.worker).toEqual({ alive: false, last_heartbeat: null, queues: null });
    });

    it('a hanging Redis times out instead of hanging the endpoint', async () => {
        health._setRedisClientForTests({ ping: () => new Promise(() => {}), get: () => new Promise(() => {}) });
        const t0 = Date.now();
        const res = await request(app).get('/api/health');
        expect(Date.now() - t0).toBeLessThan(5000);
        expect(res.body.redis).toEqual({ reachable: false });
    });
});

describe('GET /api/health — correlation DPIA gate (spec §20)', () => {
    it('states that correlation is off until a DPIA is recorded', async () => {
        const prior = { ...process.env };
        delete process.env.CORRELATION_DPIA_REF;
        try {
            const res = await request(app).get('/api/health');
            expect(res.body.correlation).toEqual({
                enabled: false, status: 'awaiting_dpia', reason: expect.stringMatching(/DPIA/), checked_by: 'web', checked_at: null,
            });
        } finally {
            process.env.CORRELATION_DPIA_REF = prior.CORRELATION_DPIA_REF;
            if (prior.CORRELATION_DPIA_REF === undefined) delete process.env.CORRELATION_DPIA_REF;
        }
    });
});

// PR #22 security L1: the web process does not hold CORRELATION_SALT. The
// worker publishes its gate status with its heartbeat; without it, web
// reports only what its env (a presence flag for the salt) can tell.
describe('GET /api/health — correlation without the salt on web (security L1)', () => {
    const health = require('../../src/routes/health');
    const { CORRELATION_KEY } = require('../../src/workers/heartbeat');
    const KEYS = ['CORRELATION_DPIA_REF', 'CORRELATION_ENABLED', 'CORRELATION_SALT', 'CORRELATION_SALT_SET'];
    let saved;
    beforeEach(() => {
        saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
        health._setQueueCountsForTests(async () => ({}));
    });
    afterEach(() => {
        for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        health._setRedisClientForTests(null);
        health._setQueueCountsForTests(null);
    });
    const open = (extra) => {
        process.env.CORRELATION_DPIA_REF = 'DPIA-2026-07';
        process.env.CORRELATION_ENABLED = 'true';
        delete process.env.CORRELATION_SALT;
        delete process.env.CORRELATION_SALT_SET;
        Object.assign(process.env, extra);
    };

    it('serves the status the worker published (checked_by worker)', async () => {
        open({ CORRELATION_SALT_SET: 'set' });
        const published = JSON.stringify({ enabled: true, status: 'enabled', reason: 'enabled under DPIA DPIA-2026-07', checked_at: '2026-09-29T10:00:00.000Z' });
        const get = jest.fn(async k => (k === CORRELATION_KEY ? published : new Date().toISOString()));
        health._setRedisClientForTests({ ping: async () => 'PONG', get });
        const res = await request(app).get('/api/health');
        expect(res.body.correlation).toEqual({
            enabled: true, status: 'enabled', reason: 'enabled under DPIA DPIA-2026-07', checked_by: 'worker', checked_at: '2026-09-29T10:00:00.000Z',
        });
        expect(get).toHaveBeenCalledWith(CORRELATION_KEY);
    });

    it('without a published status: a salt set for the worker only is "unverified" (never enabled)', async () => {
        open({ CORRELATION_SALT_SET: 'set' });
        health._setRedisClientForTests({ ping: async () => 'PONG', get: async () => null });
        const res = await request(app).get('/api/health');
        expect(res.body.correlation).toMatchObject({ enabled: false, status: 'unverified', checked_by: 'web' });
        expect(res.body.correlation.reason).toMatch(/worker only/);
    });

    it('without a published status and no salt flag: misconfigured', async () => {
        open({});
        health._setRedisClientForTests({ ping: async () => { throw new Error('down'); }, get: async () => null });
        const res = await request(app).get('/api/health');
        expect(res.body.correlation).toMatchObject({ enabled: false, status: 'misconfigured', checked_by: 'web' });
    });

    it('a malformed published value is ignored (web-side report)', async () => {
        open({ CORRELATION_SALT_SET: 'set' });
        health._setRedisClientForTests({ ping: async () => 'PONG', get: async k => (k === CORRELATION_KEY ? '{"status":1}' : null) });
        const res = await request(app).get('/api/health');
        expect(res.body.correlation).toMatchObject({ status: 'unverified', checked_by: 'web' });
    });
});

