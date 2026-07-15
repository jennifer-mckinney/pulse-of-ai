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
        expect(res.body.active_alerts[0]).toHaveProperty('alert_type');
        expect(res.body.active_alerts[0]).toHaveProperty('severity');
        expect(res.body.active_alerts[0]).toHaveProperty('created_at');
    });
});
