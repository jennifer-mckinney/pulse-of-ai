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
    afterEach(() => health._setRedisClientForTests(null));

    it('reports a reachable Redis and a live worker', async () => {
        const at = new Date().toISOString();
        const get = jest.fn(async () => at);
        health._setRedisClientForTests({ ping: async () => 'PONG', get });
        const res = await request(app).get('/api/health');
        expect(res.body.redis).toEqual({ reachable: true });
        expect(res.body.worker).toEqual({ alive: true, last_heartbeat: at });
        expect(get).toHaveBeenCalledWith(HEARTBEAT_KEY);
    });

    it('reports a dead worker when no heartbeat is stored', async () => {
        health._setRedisClientForTests({ ping: async () => 'PONG', get: async () => null });
        const res = await request(app).get('/api/health');
        expect(res.body.worker).toEqual({ alive: false, last_heartbeat: null });
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
        expect(res.body.worker).toEqual({ alive: false, last_heartbeat: null });
    });

    it('a hanging Redis times out instead of hanging the endpoint', async () => {
        health._setRedisClientForTests({ ping: () => new Promise(() => {}), get: () => new Promise(() => {}) });
        const t0 = Date.now();
        const res = await request(app).get('/api/health');
        expect(Date.now() - t0).toBeLessThan(5000);
        expect(res.body.redis).toEqual({ reachable: false });
    });
});
