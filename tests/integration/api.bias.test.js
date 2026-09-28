// tests/integration/api.bias.test.js
// Tests for GET /api/bias/latest
// Verifies: response shape, violations array, empty state.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { dbRun } = require('../../src/db/connection');
const { insertJob } = require('./helpers');

// Insert a bias_assessments row directly for testing the route
async function insertBiasAssessment(jobId, { isViolation = false } = {}) {
    await dbRun(
        `INSERT INTO bias_assessments
            (job_id, assessment_type, group_field, group_value,
             metric_name, metric_value, threshold, is_violation, severity)
         VALUES ($1, 'location_concentration', 'location', 'San Francisco',
                 'share_of_total', $2, 0.60, $3, $4)`,
        [jobId, isViolation ? 0.75 : 0.40, isViolation, isViolation ? 'warning' : null],
    );
}

describe('GET /api/bias/latest', () => {
    it('returns 200 with correct top-level shape', async () => {
        const res = await request(app).get('/api/bias/latest');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            violations:      expect.any(Array),
            all_assessments: expect.any(Array),
        });
        // Keys must be present even when null — dedicated tests verify the values
        expect(res.body).toHaveProperty('job_id');
        expect(res.body).toHaveProperty('assessed_at');
    });

    it('returns empty arrays when no bias assessments exist', async () => {
        const res = await request(app).get('/api/bias/latest');
        expect(res.body.violations).toHaveLength(0);
        expect(res.body.all_assessments).toHaveLength(0);
        expect(res.body.job_id).toBeNull();
    });

    it('returns violations from the most recently completed job', async () => {
        const jobId = await insertJob('completed');
        await insertBiasAssessment(jobId, { isViolation: true });

        const res = await request(app).get('/api/bias/latest');

        expect(res.body.job_id).toBe(jobId);
        expect(res.body.violations).toHaveLength(1);
        expect(res.body.violations[0]).toMatchObject({
            assessment_type: 'location_concentration',
            is_violation:    true,
            metric_value:    expect.any(Number),
            threshold:       expect.any(Number),
        });
    });

    it('all_assessments includes both violations and non-violations', async () => {
        const jobId = await insertJob('completed');
        await insertBiasAssessment(jobId, { isViolation: false });
        await insertBiasAssessment(jobId, { isViolation: true });

        const res = await request(app).get('/api/bias/latest');

        expect(res.body.all_assessments).toHaveLength(2);
        expect(res.body.violations).toHaveLength(1);
    });

    it('only returns assessments from the most recent completed job', async () => {
        const oldJobId = await insertJob('completed');
        await insertBiasAssessment(oldJobId, { isViolation: true });

        const newJobId = await insertJob('completed');
        // No violations in new job

        const res = await request(app).get('/api/bias/latest');

        expect(res.body.job_id).toBe(newJobId);
        expect(res.body.violations).toHaveLength(0);
    });
});

// ─── GET /api/bias/history (gap G19: 12h alert history for the health drawer) ─

describe('GET /api/bias/history', () => {
    const {
        insertBiasMethodology,
        insertBiasAssessment,
    } = require('./helpers');

    it('returns 200 with the window/alerts shape and defaults to 12 hours', async () => {
        const res = await request(app).get('/api/bias/history');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            window_hours: 12,
            generated_at: expect.any(String),
            alerts:       expect.any(Array),
        });
    });

    it('returns 400 when hours is not an integer', async () => {
        const res = await request(app).get('/api/bias/history?hours=1.5');
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('clamps out-of-range hours instead of rejecting them', async () => {
        const res = await request(app).get('/api/bias/history?hours=500');
        expect(res.status).toBe(200);
        expect(res.body.window_hours).toBe(48);

        const res2 = await request(app).get('/api/bias/history?hours=-3');
        expect(res2.body.window_hours).toBe(1);
    });

    it('maps stored severities to the alert|watch|pass vocabulary with layer + citation', async () => {
        await insertBiasMethodology();
        const jobId = await insertJob('completed');

        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration',
            metricValue: 0.85, threshold: 0.35,
            isViolation: true, severity: 'critical',
        });
        await insertBiasAssessment(jobId, {
            assessmentType: 'negative_dominance',
            groupField: 'global', groupValue: 'all',
            metricName: 'negative_share',
            metricValue: 0.65, threshold: 0.60,
            isViolation: true, severity: 'warning',
        });
        await insertBiasAssessment(jobId, {
            assessmentType: 'platform_sentiment_parity',
            groupField: 'platform', groupValue: 'social vs news',
            metricName: 'max_comparative_diff',
            metricValue: 0.03, threshold: 0.30,
            isViolation: false,
        });

        const res = await request(app).get('/api/bias/history');
        expect(res.body.alerts).toHaveLength(3);

        const critical = res.body.alerts.find(a => a.assessment_type === 'location_concentration');
        expect(critical).toMatchObject({
            severity: 'alert',
            layer:    'Location concentration',
            value:    0.85,
            threshold: 0.35,
            citation: 'Suresh & Guttag (2021)',
        });
        expect(critical.detail).toContain('τ = 0.35');
        expect(critical.time).toEqual(expect.any(String));

        const warning = res.body.alerts.find(a => a.assessment_type === 'negative_dominance');
        expect(warning.severity).toBe('watch');

        const ok = res.body.alerts.find(a => a.assessment_type === 'platform_sentiment_parity');
        expect(ok).toMatchObject({
            severity: 'pass',
            layer:    'Demographic parity (source category)',
            citation: 'Barocas & Selbst (2016)',
        });
    });

    it('excludes assessments older than the window and orders newest first', async () => {
        const jobId = await insertJob('completed');

        // 13 hours old — outside the default 12h window
        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration',
            createdAt: new Date(Date.now() - 13 * 3600 * 1000),
        });
        // 1 hour old — inside
        const recentId = await insertBiasAssessment(jobId, {
            assessmentType: 'negative_dominance',
            groupField: 'global', groupValue: 'all',
            createdAt: new Date(Date.now() - 1 * 3600 * 1000),
        });
        // just now — inside
        await insertBiasAssessment(jobId, {
            assessmentType: 'platform_sentiment_parity',
            groupField: 'platform', groupValue: 'social vs news',
        });

        const res = await request(app).get('/api/bias/history');
        expect(res.body.alerts).toHaveLength(2);
        // Newest first
        expect(res.body.alerts[0].assessment_type).toBe('platform_sentiment_parity');
        expect(res.body.alerts[1].id).toBe(recentId);

        // Widening the window picks the old row back up
        const wide = await request(app).get('/api/bias/history?hours=48');
        expect(wide.body.alerts).toHaveLength(3);
    });

    it('degrades without a bias methodology: title-cased layer, null citation', async () => {
        const jobId = await insertJob('completed');
        await insertBiasAssessment(jobId, { assessmentType: 'location_concentration' });

        const res = await request(app).get('/api/bias/history');
        expect(res.body.alerts[0]).toMatchObject({
            layer:    'Location concentration',
            citation: null,
        });
    });
});
