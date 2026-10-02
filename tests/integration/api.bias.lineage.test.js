// tests/integration/api.bias.lineage.test.js
// PR #8 review: receipts and alert history must render each assessment with
// the bias methodology version that PRODUCED it — not whichever version is
// newest. Two registered versions with different layer names / citations /
// notes; assessments made before and after the second one.
//
//   recorded — bias_assessments.methodology_version_id (migration 010)
//   inferred — pre-lineage rows (NULL column): the version whose
//              effective_from is at or before the row's created_at
//
// Methodology rows are never edited: a version change is a NEW row plus
// deprecated_at on the old one — exactly how these fixtures model it.

'use strict';

const { useServer } = require('../helpers/server');
const app     = require('../../src/server');
const request = useServer(app);   // one listener per file (tests/helpers/server.js)
const { dbRun, dbAll } = require('../../src/db/connection');
const {
    insertSource, insertJob, insertMethodologyVersions,
    insertPostWithFullPipeline, insertBiasAssessment,
} = require('./helpers');

const HOUR = 3600 * 1000;
const hoursAgo = (h) => new Date(Date.now() - h * HOUR);

const CONFIG_V1 = {
    layer_names: { location_concentration: 'Geo share (v1)', negative_dominance: 'Negativity (v1)' },
    citations:   { location_concentration: 'Old et al. (2020)', negative_dominance: 'Older (2019)' },
    layer_notes: { location_concentration: 'v1 note: city share of located posts' },
};
const CONFIG_V2 = {
    layer_names: { location_concentration: 'Location concentration (v2)', negative_dominance: 'Negative dominance (v2)' },
    citations:   { location_concentration: 'Suresh & Guttag (2021)', negative_dominance: 'Suresh & Guttag (2021)' },
    layer_notes: { location_concentration: 'v2 note: recalibrated threshold' },
};

/** v1 effective 10h ago (deprecated 2h ago), v2 effective 2h ago. */
async function registerTwoVersions() {
    const v1 = await dbRun(
        `INSERT INTO methodology_versions
            (component, version, model_name, config, justification, effective_from, deprecated_at)
         VALUES ('bias', '0.9.0', 'bias-monitor-old', $1::jsonb, 'v1', $2, $3)
         RETURNING id`,
        [JSON.stringify(CONFIG_V1), hoursAgo(10).toISOString(), hoursAgo(2).toISOString()],
    );
    const v2 = await dbRun(
        `INSERT INTO methodology_versions
            (component, version, model_name, config, justification, effective_from)
         VALUES ('bias', '2.0.0', 'bias-monitor-new', $1::jsonb, 'v2', $2)
         RETURNING id`,
        [JSON.stringify(CONFIG_V2), hoursAgo(2).toISOString()],
    );
    return { v1: v1.id, v2: v2.id };
}

async function methodologySnapshot() {
    return dbAll(
        `SELECT id, component, version, model_name, config, justification,
                effective_from, deprecated_at
         FROM methodology_versions ORDER BY id`,
    );
}

describe('bias methodology lineage — GET /api/audit/:post_id bias block', () => {
    it('a receipt for a job assessed BEFORE a version change keeps the old version, names, citations and notes (recorded)', async () => {
        const { v1 } = await registerTwoVersions();
        const srcId  = await insertSource('lineage-audit-1');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'lin-a-1' });
        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration',
            metricValue: 0.41, threshold: 0.35, isViolation: true, severity: 'warning',
            createdAt: hoursAgo(5), methodologyVersionId: v1,
        });

        const before = await methodologySnapshot();
        const res = await request().get(`/api/audit/${postId}`);
        expect(res.status).toBe(200);
        expect(res.body.bias).toMatchObject({
            model_name: 'bias-monitor-old',
            version:    '0.9.0',
            lineage:    'recorded',
            lineage_fallback: false,
        });
        const loc = res.body.bias.layers.find(l => l.assessment_type === 'location_concentration');
        expect(loc).toMatchObject({
            name:     'Geo share (v1)',
            citation: 'Old et al. (2020)',
            note:     'v1 note: city share of located posts',
        });

        // Reading never edits methodology rows.
        expect(await methodologySnapshot()).toEqual(before);
    });

    it('a job assessed AFTER the change renders the new version (recorded)', async () => {
        const { v2 } = await registerTwoVersions();
        const srcId  = await insertSource('lineage-audit-2');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'lin-a-2' });
        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration',
            createdAt: hoursAgo(1), methodologyVersionId: v2,
        });

        const res = await request().get(`/api/audit/${postId}`);
        expect(res.body.bias).toMatchObject({ version: '2.0.0', lineage: 'recorded' });
        const loc = res.body.bias.layers.find(l => l.assessment_type === 'location_concentration');
        expect(loc).toMatchObject({
            name: 'Location concentration (v2)', citation: 'Suresh & Guttag (2021)',
        });
    });

    it('a pre-lineage job (NULL column) assessed before the change is INFERRED to the old version', async () => {
        await registerTwoVersions();
        const srcId  = await insertSource('lineage-audit-3');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'lin-a-3' });
        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration',
            createdAt: hoursAgo(5), methodologyVersionId: null,
        });

        const res = await request().get(`/api/audit/${postId}`);
        expect(res.body.bias).toMatchObject({
            model_name: 'bias-monitor-old', version: '0.9.0',
            lineage: 'inferred', lineage_fallback: false,
        });
        expect(res.body.bias.layers.find(l => l.assessment_type === 'location_concentration').name)
            .toBe('Geo share (v1)');
    });

    it('a pre-lineage row older than every version falls back to the EARLIEST version, flagged', async () => {
        await registerTwoVersions();
        const srcId  = await insertSource('lineage-audit-4');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'lin-a-4' });
        await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration',
            createdAt: hoursAgo(11), methodologyVersionId: null,
        });

        const res = await request().get(`/api/audit/${postId}`);
        expect(res.body.bias).toMatchObject({
            version: '0.9.0', lineage: 'inferred', lineage_fallback: true,
        });
    });

    it('a job with no assessments lists the CURRENT version\'s planned layers, labeled lineage "current"', async () => {
        await registerTwoVersions();
        const srcId  = await insertSource('lineage-audit-5');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'lin-a-5' });

        const res = await request().get(`/api/audit/${postId}`);
        expect(res.body.bias).toMatchObject({
            assessed_at: null, version: '2.0.0', lineage: 'current',
        });
    });
});

describe('bias methodology lineage — GET /api/bias/history', () => {
    it('renders every row with ITS producing version — old rows keep old names/citations after the change', async () => {
        const { v1, v2 } = await registerTwoVersions();
        const jobId = await insertJob('completed');

        // Flagged rows (listed individually), one per lineage case.
        const oldRecorded = await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration', isViolation: true, severity: 'warning',
            createdAt: hoursAgo(5), methodologyVersionId: v1,
        });
        const newRecorded = await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration', isViolation: true, severity: 'critical',
            createdAt: hoursAgo(1), methodologyVersionId: v2,
        });
        const oldInferred = await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration', isViolation: true, severity: 'warning',
            createdAt: hoursAgo(6), methodologyVersionId: null,
        });
        const newInferred = await insertBiasAssessment(jobId, {
            assessmentType: 'location_concentration', isViolation: true, severity: 'warning',
            createdAt: hoursAgo(1.5), methodologyVersionId: null,
        });

        const res = await request().get('/api/bias/history');
        expect(res.status).toBe(200);
        const byId = Object.fromEntries(res.body.alerts.map(a => [a.id, a]));

        expect(byId[oldRecorded]).toMatchObject({
            layer: 'Geo share (v1)', citation: 'Old et al. (2020)',
            model_name: 'bias-monitor-old', version: '0.9.0', lineage: 'recorded',
        });
        expect(byId[oldRecorded].detail).toContain('Geo share (v1)');
        expect(byId[newRecorded]).toMatchObject({
            layer: 'Location concentration (v2)', citation: 'Suresh & Guttag (2021)',
            version: '2.0.0', lineage: 'recorded',
        });
        expect(byId[oldInferred]).toMatchObject({
            layer: 'Geo share (v1)', version: '0.9.0', lineage: 'inferred',
        });
        expect(byId[newInferred]).toMatchObject({
            layer: 'Location concentration (v2)', version: '2.0.0', lineage: 'inferred',
        });
    });

    it('pass summaries carry the lineage of their latest row', async () => {
        const { v1 } = await registerTwoVersions();
        const jobId = await insertJob('completed');
        await insertBiasAssessment(jobId, {
            assessmentType: 'negative_dominance', groupField: 'global', groupValue: 'all',
            metricName: 'negative_share', metricValue: 0.2, threshold: 0.6,
            createdAt: hoursAgo(7), methodologyVersionId: v1,
        });
        await insertBiasAssessment(jobId, {
            assessmentType: 'negative_dominance', groupField: 'global', groupValue: 'all',
            metricName: 'negative_share', metricValue: 0.3, threshold: 0.6,
            createdAt: hoursAgo(1), methodologyVersionId: null,
        });

        const res = await request().get('/api/bias/history');
        const nd = res.body.pass_summary.find(p => p.assessment_type === 'negative_dominance');
        expect(nd).toMatchObject({
            count: 2, latest_value: 0.3,
            layer: 'Negative dominance (v2)', version: '2.0.0', lineage: 'inferred',
        });
    });
});
