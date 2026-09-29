// tests/integration/api.bias.test.js
// Tests for GET /api/bias/latest
// Verifies: response shape, violations array, empty state.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { dbRun } = require('../../src/db/connection');
const { insertJob } = require('./helpers');

// Insert a bias_assessments row directly for testing the route. Lineage is
// an explicit option (default NULL = pre-lineage row), never silently
// stamped with the newest version — see api.bias.lineage.test.js.
async function insertBiasAssessment(jobId, { isViolation = false, methodologyVersionId = null } = {}) {
    await dbRun(
        `INSERT INTO bias_assessments
            (job_id, assessment_type, group_field, group_value,
             metric_name, metric_value, threshold, is_violation, severity,
             methodology_version_id)
         VALUES ($1, 'location_concentration', 'location', 'San Francisco',
                 'share_of_total', $2, 0.60, $3, $4, $5)`,
        [jobId, isViolation ? 0.75 : 0.40, isViolation, isViolation ? 'warning' : null,
         methodologyVersionId],
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

    it('skips a newer completed job that processed no posts (nothing to assess)', async () => {
        const jobId = await insertJob('completed');
        await insertBiasAssessment(jobId, { isViolation: true, severity: 'warning' });
        await insertJob('completed', { postsProcessed: 0 });   // e.g. a refresh that found nothing new
        const res = await request(app).get('/api/bias/latest');
        expect(res.body.job_id).toBe(jobId);
        expect(res.body.all_assessments).toHaveLength(1);
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
// PR #8 review: the endpoint must cover the WHOLE requested window truthfully.
// At the 2–3 min cadence a 12h window holds ~720–1,080 assessments, so a flat
// row cap silently showed a fraction. Now:
//   alerts       — EVERY flagged (alert|watch) row, newest first (rare), with a
//                  hard safety cap; truncated + alert_count when it is hit
//   pass_summary — pass rows collapsed to one summary per layer (count,
//                  first/last time, latest value, threshold)
//   one DB timestamp anchors every query (generated_at = that anchor)

describe('GET /api/bias/history', () => {
    const {
        insertBiasMethodology,
        insertBiasAssessment,
    } = require('./helpers');
    const clock = require('../../src/db/clock');
    const { HISTORY_ALERT_CAP } = require('../../src/routes/bias');

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns 200 with the window / alerts / pass_summary / truncation shape and defaults to 12 hours', async () => {
        const res = await request(app).get('/api/bias/history');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            window_hours: 12,
            generated_at: expect.any(String),
            window_start: expect.any(String),
            alerts:       [],
            pass_summary: [],
            total_count:  0,
            alert_count:  0,
            pass_count:   0,
            truncated:    false,
            alert_cap:    HISTORY_ALERT_CAP,
        });
        expect(Date.parse(res.body.generated_at) - Date.parse(res.body.window_start))
            .toBe(12 * 3600 * 1000);
    });

    it('returns 400 when hours is not an integer', async () => {
        const res = await request(app).get('/api/bias/history?hours=1.5');
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('clamps out-of-range positive hours instead of rejecting them', async () => {
        const res = await request(app).get('/api/bias/history?hours=500');
        expect(res.status).toBe(200);
        expect(res.body.window_hours).toBe(48);
    });

    it('rejects negative hours as 400 (F5 — a negative window is malformed, not clampable)', async () => {
        const res = await request(app).get('/api/bias/history?hours=-3');
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('lists flagged rows as alert|watch with layer + citation; passes go to pass_summary', async () => {
        const biasMvId = await insertBiasMethodology();
        const jobId = await insertJob('completed');

        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration',
            metricValue: 0.85, threshold: 0.35,
            isViolation: true, severity: 'critical',
            methodologyVersionId: biasMvId,          // recorded lineage
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
        expect(res.body.alerts).toHaveLength(2);
        expect(res.body.alerts.every(a => a.severity !== 'pass')).toBe(true);
        expect(res.body).toMatchObject({ total_count: 3, alert_count: 2, pass_count: 1, truncated: false });

        const critical = res.body.alerts.find(a => a.assessment_type === 'location_concentration');
        expect(critical).toMatchObject({
            severity: 'alert',
            layer:    'Location concentration',
            value:    0.85,
            threshold: 0.35,
            citation: 'Suresh & Guttag (2021)',
            model_name: 'pulse-bias-monitor-v1',
            version:  '1.1.0',
            lineage:  'recorded',
        });
        expect(critical.detail).toContain('τ = 0.35');
        expect(critical.time).toEqual(expect.any(String));

        const warning = res.body.alerts.find(a => a.assessment_type === 'negative_dominance');
        expect(warning.severity).toBe('watch');
        // No recorded id → resolved from effective_from, labeled inferred.
        expect(warning).toMatchObject({ version: '1.1.0', lineage: 'inferred' });

        expect(res.body.pass_summary).toEqual([expect.objectContaining({
            severity:        'pass',
            assessment_type: 'platform_sentiment_parity',
            layer:           'Demographic parity',   // prototype's exact layer name
            citation:        'Barocas & Selbst (2016)',
            count:           1,
            latest_value:    0.03,
            threshold:       0.30,
        })]);
    });

    it('collapses pass rows into ONE summary per layer covering the whole window', async () => {
        await insertBiasMethodology();
        const jobId = await insertJob('completed');
        const times = [11, 8, 5, 3, 0.5];          // hours ago, oldest → newest
        for (const [i, h] of times.entries()) {
            await insertBiasAssessment(jobId, {
                assessmentType: 'location_concentration',
                metricValue: 0.1 + i * 0.01, threshold: 0.35,
                createdAt: new Date(Date.now() - h * 3600 * 1000),
            });
        }
        await insertBiasAssessment(jobId, {
            assessmentType: 'negative_dominance', groupField: 'global', groupValue: 'all',
            metricName: 'negative_share', metricValue: 0.2, threshold: 0.6,
            createdAt: new Date(Date.now() - 2 * 3600 * 1000),
        });

        const res = await request(app).get('/api/bias/history');
        expect(res.body.alerts).toEqual([]);
        expect(res.body).toMatchObject({ total_count: 6, pass_count: 6, alert_count: 0 });
        expect(res.body.pass_summary).toHaveLength(2);

        const loc = res.body.pass_summary.find(p => p.assessment_type === 'location_concentration');
        expect(loc).toMatchObject({
            layer: 'Location concentration', count: 5,
            latest_value: 0.14, threshold: 0.35, metric_name: 'share_of_total',
        });
        // first/last span the oldest and newest pass rows in the window
        expect(Date.now() - Date.parse(loc.first_time)).toBeGreaterThan(10.9 * 3600 * 1000);
        expect(Date.now() - Date.parse(loc.last_time)).toBeLessThan(0.6 * 3600 * 1000);
        expect(loc.detail).toBe('5 passing checks in the window · latest share_of_total 0.140 (τ = 0.35).');
    });

    it('merges a synonym-typed pass row into its canonical layer summary', async () => {
        await insertBiasMethodology();
        const jobId = await insertJob('completed');
        await insertBiasAssessment(jobId, {
            assessmentType: 'demographic_parity', groupField: 'platform', groupValue: 'all',
            metricName: 'max_comparative_diff', metricValue: 0.05, threshold: 0.3,
            createdAt: new Date(Date.now() - 4 * 3600 * 1000),
        });
        await insertBiasAssessment(jobId, {
            assessmentType: 'platform_sentiment_parity', groupField: 'platform', groupValue: 'all',
            metricName: 'max_comparative_diff', metricValue: 0.07, threshold: 0.3,
            createdAt: new Date(Date.now() - 1 * 3600 * 1000),
        });

        const res = await request(app).get('/api/bias/history');
        expect(res.body.pass_summary).toHaveLength(1);
        expect(res.body.pass_summary[0]).toMatchObject({
            assessment_type: 'platform_sentiment_parity',
            layer: 'Demographic parity', count: 2, latest_value: 0.07,
        });
    });

    it('excludes assessments older than the window and orders flagged rows newest first', async () => {
        const jobId = await insertJob('completed');

        // 13 hours old — outside the default 12h window
        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration', isViolation: true, severity: 'warning',
            createdAt: new Date(Date.now() - 13 * 3600 * 1000),
        });
        // 1 hour old — inside
        const recentId = await insertBiasAssessment(jobId, {
            assessmentType: 'negative_dominance', isViolation: true, severity: 'warning',
            groupField: 'global', groupValue: 'all',
            createdAt: new Date(Date.now() - 1 * 3600 * 1000),
        });
        // just now — inside
        await insertBiasAssessment(jobId, {
            assessmentType: 'platform_sentiment_parity', isViolation: true, severity: 'critical',
            groupField: 'platform', groupValue: 'social vs news',
        });

        const res = await request(app).get('/api/bias/history');
        expect(res.body.alerts).toHaveLength(2);
        expect(res.body.total_count).toBe(2);
        // Newest first
        expect(res.body.alerts[0].assessment_type).toBe('platform_sentiment_parity');
        expect(res.body.alerts[1].id).toBe(recentId);

        // Widening the window picks the old row back up
        const wide = await request(app).get('/api/bias/history?hours=48');
        expect(wide.body.alerts).toHaveLength(3);
    });

    it('caps flagged rows at the safety cap and reports truncated + the true total', async () => {
        const jobId = await insertJob('completed');
        const extra = 5;
        await dbRun(
            `INSERT INTO bias_assessments
                (job_id, assessment_type, group_field, group_value, metric_name,
                 metric_value, threshold, is_violation, severity, created_at)
             SELECT $1, 'location_concentration', 'location', 'City ' || g, 'share_of_total',
                    0.5, 0.35, TRUE, 'warning', NOW() - (g * INTERVAL '1 second')
             FROM generate_series(1, $2::int) AS g`,
            [jobId, HISTORY_ALERT_CAP + extra],
        );

        const res = await request(app).get('/api/bias/history');
        expect(res.body.alerts).toHaveLength(HISTORY_ALERT_CAP);
        expect(res.body).toMatchObject({
            truncated:   true,
            alert_count: HISTORY_ALERT_CAP + extra,
            total_count: HISTORY_ALERT_CAP + extra,
        });
        // The NEWEST rows are the ones kept.
        expect(res.body.alerts[0].group_value).toBe('City 1');
    });

    it('is not truncated when flagged rows exactly fill the cap', async () => {
        const jobId = await insertJob('completed');
        await dbRun(
            `INSERT INTO bias_assessments
                (job_id, assessment_type, group_field, group_value, metric_name,
                 metric_value, threshold, is_violation, severity, created_at)
             SELECT $1, 'location_concentration', 'location', 'City ' || g, 'share_of_total',
                    0.5, 0.35, TRUE, 'warning', NOW() - (g * INTERVAL '1 second')
             FROM generate_series(1, $2::int) AS g`,
            [jobId, HISTORY_ALERT_CAP],
        );
        const res = await request(app).get('/api/bias/history');
        expect(res.body.alerts).toHaveLength(HISTORY_ALERT_CAP);
        expect(res.body.truncated).toBe(false);
    });

    it('anchors every query on ONE database timestamp (rows after the anchor are excluded everywhere)', async () => {
        const jobId = await insertJob('completed');
        const anchor = new Date(Date.now() - 3 * 3600 * 1000);   // pinned 3h in the past
        const at = (offsetH) => new Date(anchor.getTime() + offsetH * 3600 * 1000);

        // Inside the anchored window: [anchor - 12h, anchor]
        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration', isViolation: true, severity: 'warning',
            createdAt: at(-1),
        });
        await insertBiasAssessment(jobId, {
            assessmentType: 'negative_dominance', createdAt: at(-2),
        });
        // Boundary: exactly at the window start is included
        await insertBiasAssessment(jobId, {
            assessmentType: 'negative_dominance', createdAt: at(-12),
        });
        // After the anchor — excluded from list, summary AND counts
        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration', isViolation: true, severity: 'critical',
            createdAt: at(+1),
        });
        await insertBiasAssessment(jobId, {
            assessmentType: 'negative_dominance', createdAt: at(+1),
        });

        const spy = jest.spyOn(clock, 'dbNow').mockResolvedValue(anchor);
        const res = await request(app).get('/api/bias/history');

        expect(spy).toHaveBeenCalledTimes(1);
        expect(res.body.generated_at).toBe(anchor.toISOString());
        expect(res.body.window_start).toBe(at(-12).toISOString());
        expect(res.body.alerts).toHaveLength(1);
        expect(res.body.alerts[0].severity).toBe('watch');
        expect(res.body).toMatchObject({ total_count: 3, alert_count: 1, pass_count: 2 });
        expect(res.body.pass_summary).toHaveLength(1);
        expect(res.body.pass_summary[0]).toMatchObject({ assessment_type: 'negative_dominance', count: 2 });
        expect(res.body.pass_summary[0].last_time).toBe(at(-2).toISOString());
    });

    it('degrades without a bias methodology: title-cased layer, null citation, null lineage', async () => {
        const jobId = await insertJob('completed');
        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration', isViolation: true, severity: 'warning',
        });

        const res = await request(app).get('/api/bias/history');
        expect(res.body.alerts[0]).toMatchObject({
            layer:    'Location concentration',
            citation: null,
            version:  null,
            lineage:  null,
        });
    });
});
