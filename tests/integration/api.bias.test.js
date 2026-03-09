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
