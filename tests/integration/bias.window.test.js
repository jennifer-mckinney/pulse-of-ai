// tests/integration/bias.window.test.js
// PR #22 decision G2 (bias@1.5.0) and principal #11:
//   - runBiasWindow() runs the three fairness checks over every post scored
//     in the last 24 h, ACROSS cycles, so the minimum samples are reachable;
//     it records a bias_window_runs row and append-only
//     bias_window_assessments rows linked to bias@1.5.0; a violation raises
//     an alert that names the window run; posts outside the window are out.
//   - insufficientSampleReport() / GET /api/bias/latest / GET /api/health
//     report the insufficient-sample share per check.
//   - `npm run bias:window` (scripts/bias-window.js) runs it on demand.

'use strict';

const crypto = require('crypto');
const request = require('supertest');
const app = require('../../src/server');
const { dbGet, dbAll, dbRun } = require('../../src/db/connection');
const { METHODOLOGY_VERSIONS, CURRENT_VERSIONS } = require('../../src/config/methodology-registry');
const { runBiasWindow, insufficientSampleReport, CHECKS } = require('../../src/pipeline/bias-window');
const { runBiasChecks } = require('../../src/pipeline/bias');
const { insertJob, insertSource, insertBiasAssessment } = require('./helpers');

async function registerBias(version) {
    const m = METHODOLOGY_VERSIONS.find(r => r.component === 'bias' && r.version === version);
    const row = await dbRun(
        `INSERT INTO methodology_versions (component, version, model_name, config, justification)
         VALUES ('bias', $1, $2, $3::jsonb, $4) RETURNING id`,
        [m.version, m.model_name, JSON.stringify(m.config), m.justification],
    );
    return row.id;
}

async function sentimentMv() {
    const row = await dbRun(
        `INSERT INTO methodology_versions (component, version, model_name, config, justification)
         VALUES ('sentiment', '1.0.0', 'afinn-sentiment-v5', '{}'::jsonb, 'AFINN') RETURNING id`,
    );
    return row.id;
}

let seq = 0;
/** A post scored under jobId, its sentiment decision recorded `agoHours` ago. */
async function scoredPost(sourceId, jobId, mvId, { location = null, indicator = 'positive', comparative = 0.2, agoHours = 1 } = {}) {
    seq += 1;
    const content = `window post ${seq} ${Math.random()}`;
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const post = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [sourceId, `w${seq}`, content, hash, location],
    );
    const audit = await dbRun(
        `INSERT INTO decision_audit_log
            (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output, created_at)
         VALUES ($1, $2, $3, 'sentiment', 'afinn-sentiment-v5', $4, $5::jsonb, NOW() - make_interval(hours => $6))
         RETURNING id`,
        [post.id, jobId, mvId, hash, JSON.stringify({ indicator, comparative }), agoHours],
    );
    await dbRun(
        `INSERT INTO sentiment_results
            (raw_post_id, audit_id, score, comparative, indicator, positive_words, negative_words, token_count)
         VALUES ($1, $2, $3, $4, $5, '{}', '{}', 5)`,
        [post.id, audit.id, comparative * 10, comparative, indicator],
    );
    return post.id;
}

describe('runBiasWindow (bias@1.5.0, G2)', () => {
    it('bias@1.5.0 is the version the code runs, with a 24 h rolling window', () => {
        expect(CURRENT_VERSIONS.bias).toBe('1.5.0');
        const cfg = METHODOLOGY_VERSIONS.find(r => r.component === 'bias' && r.version === '1.5.0').config;
        expect(cfg.rolling_window).toMatchObject({ hours: 24 });
        expect(cfg.rolling_window.checks).toEqual(CHECKS);
    });

    it('refuses to run without a registered bias@1.5.0 (no run row written)', async () => {
        await expect(runBiasWindow()).rejects.toThrow(/bias@1\.5\.0 is not registered/);
        expect(await dbAll('SELECT id FROM bias_window_runs')).toEqual([]);
    });

    it('refuses an unknown trigger', async () => {
        await expect(runBiasWindow({ triggeredBy: 'cron' })).rejects.toThrow(/unknown bias window trigger/);
    });

    it('pools posts from many small cycles: each cycle is "insufficient sample", the 24 h window is not', async () => {
        const mv = await registerBias('1.5.0');
        const sMv = await sentimentMv();
        const news = await insertSource('w-news', 'news');
        const forums = await insertSource('w-forums', 'forums');
        // Ten cycles of 4 posts each (2 news in Tokyo, 2 forums in Paris).
        const jobs = [];
        for (let c = 0; c < 10; c++) {
            const job = await insertJob('completed');
            jobs.push(job);
            for (let i = 0; i < 2; i++) await scoredPost(news, job, sMv, { location: 'Tokyo', comparative: 0.3 });
            for (let i = 0; i < 2; i++) await scoredPost(forums, job, sMv, { location: 'Paris', comparative: 0.1 });
        }
        // Outside the window: 30 negative, all-London posts 30 h ago.
        const old = await insertJob('completed');
        for (let i = 0; i < 30; i++) await scoredPost(news, old, sMv, { location: 'London', indicator: 'negative', agoHours: 30 });

        await runBiasChecks(jobs[0], mv);
        const cycle = await dbAll('SELECT group_value FROM bias_assessments WHERE job_id = $1', [jobs[0]]);
        expect(cycle.map(r => r.group_value)).toEqual(['insufficient sample', 'insufficient sample', 'insufficient sample']);

        const r = await runBiasWindow({ triggeredBy: 'on_demand' });
        expect(r).toMatchObject({ version: '1.5.0', windowHours: 24, postsAssessed: 40, violationsFound: 1 });
        const run = await dbGet('SELECT * FROM bias_window_runs WHERE id = $1', [r.runId]);
        expect(run).toMatchObject({
            status: 'completed', triggered_by: 'on_demand', window_hours: 24, posts_assessed: 40,
            violations_found: 1, methodology_version_id: mv, error_details: null,
        });
        expect(new Date(run.window_end) - new Date(run.window_start)).toBe(24 * 3600 * 1000);

        const rows = await dbAll(
            `SELECT assessment_type, group_value, is_violation, metric_value, methodology_version_id, evidence
             FROM bias_window_assessments WHERE window_run_id = $1 ORDER BY assessment_type`, [r.runId]);
        expect(rows.map(x => [x.assessment_type, x.group_value, x.is_violation])).toEqual([
            // 40 content-located posts, Tokyo and Paris 50 % each: above the 0.35 threshold.
            ['location_concentration', expect.stringMatching(/^(Tokyo|Paris)$/), true],
            ['negative_dominance', 'all', false],
            // 20 posts in each category: compared (gap 0.2 <= 0.3).
            ['platform_sentiment_parity', expect.stringMatching(/ vs /), false],
        ]);
        expect(rows.every(x => x.methodology_version_id === mv)).toBe(true);
        expect(rows[0].evidence.total).toBe(40);                // the old London posts are outside
        // The per-cycle table is untouched by the window run.
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM bias_assessments')).n).toBe(3);

        const alert = await dbGet(`SELECT alert_type, source_table, details FROM alert_events`);
        expect(alert).toMatchObject({ alert_type: 'location_concentration', source_table: 'bias_window_assessments' });
        expect(alert.details).toMatchObject({ windowRunId: r.runId, scope: 'rolling_window', share: 0.5 });
        expect(alert.details.jobId).toBeUndefined();
    });

    it('bias_window_assessments are append-only', async () => {
        await registerBias('1.5.0');
        const r = await runBiasWindow();
        await expect(dbRun(`UPDATE bias_window_assessments SET is_violation = TRUE WHERE window_run_id = $1`, [r.runId]))
            .rejects.toThrow(/append-only/);
        await expect(dbRun(`DELETE FROM bias_window_assessments WHERE window_run_id = $1`, [r.runId]))
            .rejects.toThrow(/append-only/);
    });

    it('an empty window records three "insufficient sample" assessments (M5) and no alert', async () => {
        await registerBias('1.5.0');
        const r = await runBiasWindow();
        expect(r).toMatchObject({ postsAssessed: 0, violationsFound: 0 });
        const rows = await dbAll('SELECT group_value FROM bias_window_assessments WHERE window_run_id = $1', [r.runId]);
        expect(rows.map(x => x.group_value)).toEqual(['insufficient sample', 'insufficient sample', 'insufficient sample']);
        expect(await dbAll('SELECT id FROM alert_events')).toEqual([]);
    });

    it('a check that throws marks the run failed (never left running) and rethrows', async () => {
        await registerBias('1.5.0');
        let isolated;
        jest.isolateModules(() => {
            jest.doMock('../../src/pipeline/bias', () => ({
                ...jest.requireActual('../../src/pipeline/bias'),
                checkPlatformSentimentParity: async () => { throw new Error('parity exploded'); },
            }));
            isolated = require('../../src/pipeline/bias-window');
        });
        await expect(isolated.runBiasWindow()).rejects.toThrow('parity exploded');
        jest.dontMock('../../src/pipeline/bias');
        const run = await dbGet('SELECT status, error_details, completed_at FROM bias_window_runs');
        expect(run.status).toBe('failed');
        expect(run.error_details).toBe('parity exploded');
        expect(run.completed_at).not.toBeNull();
    });
});

describe('insufficient-sample share (principal #11)', () => {
    async function seedCycleRows() {
        const job = await insertJob('completed');
        await insertBiasAssessment(job, { assessmentType: 'location_concentration', groupValue: 'insufficient sample' });
        await insertBiasAssessment(job, { assessmentType: 'location_concentration', groupValue: 'insufficient sample' });
        await insertBiasAssessment(job, { assessmentType: 'location_concentration', groupValue: 'Tokyo' });
        await insertBiasAssessment(job, { assessmentType: 'negative_dominance', groupValue: 'insufficient sample', groupField: 'global' });
        // 3 days ago: in the 7-day share only.
        const old = await insertBiasAssessment(job, { assessmentType: 'negative_dominance', groupValue: 'all', groupField: 'global' });
        await dbRun(`UPDATE bias_assessments SET created_at = NOW() - INTERVAL '3 days' WHERE id = $1`, [old]);
        // 9 days ago: outside both.
        const older = await insertBiasAssessment(job, { assessmentType: 'negative_dominance', groupValue: 'insufficient sample', groupField: 'global' });
        await dbRun(`UPDATE bias_assessments SET created_at = NOW() - INTERVAL '9 days' WHERE id = $1`, [older]);
        return job;
    }

    it('reports per check, per cycle over 24 h and 7 days, and the latest window run', async () => {
        await registerBias('1.5.0');
        await seedCycleRows();
        await runBiasWindow();
        const rep = await insufficientSampleReport();
        expect(rep.per_cycle.last_24h).toEqual({
            location_concentration: { assessments: 3, insufficient: 2, share: 2 / 3 },
            platform_sentiment_parity: { assessments: 0, insufficient: 0, share: null },
            negative_dominance: { assessments: 1, insufficient: 1, share: 1 },
        });
        expect(rep.per_cycle.last_7d.negative_dominance).toEqual({ assessments: 2, insufficient: 1, share: 0.5 });
        expect(rep.rolling_window.latest_run).toMatchObject({
            status: 'completed', version: '1.5.0', window_hours: 24, posts_assessed: 0, triggered_by: 'schedule',
        });
        expect(rep.rolling_window.latest_run.checks.location_concentration).toMatchObject({ outcome: 'insufficient_sample' });
        expect(rep.rolling_window.last_7d.negative_dominance).toEqual({ assessments: 1, insufficient: 1, share: 1 });
    });

    it('with nothing recorded: every share is null and there is no window run', async () => {
        const rep = await insufficientSampleReport();
        for (const c of CHECKS) {
            expect(rep.per_cycle.last_24h[c]).toEqual({ assessments: 0, insufficient: 0, share: null });
            expect(rep.rolling_window.last_7d[c]).toEqual({ assessments: 0, insufficient: 0, share: null });
        }
        expect(rep.rolling_window.latest_run).toBeNull();
    });

    it('GET /api/bias/latest and GET /api/health serve the report', async () => {
        await registerBias('1.5.0');
        await seedCycleRows();
        const bias = await request(app).get('/api/bias/latest');
        expect(bias.status).toBe(200);
        expect(bias.body.insufficient_sample.per_cycle.last_24h.location_concentration)
            .toEqual({ assessments: 3, insufficient: 2, share: 2 / 3 });
        const health = await request(app).get('/api/health');
        expect(health.status).toBe(200);
        expect(health.body.bias_sample.per_cycle.last_24h.negative_dominance)
            .toEqual({ assessments: 1, insufficient: 1, share: 1 });
        expect(health.body.bias_sample.rolling_window).toHaveProperty('latest_run', null);
    });

    it('GET /api/bias/latest serves the report with no completed job too', async () => {
        const res = await request(app).get('/api/bias/latest');
        expect(res.body.job_id).toBeNull();
        expect(res.body.insufficient_sample.per_cycle.last_7d.location_concentration.share).toBeNull();
    });

    it('GET /api/bias/history counts insufficient-sample rows apart from passes', async () => {
        await registerBias('1.5.0');
        await seedCycleRows();
        const res = await request(app).get('/api/bias/history');
        expect(res.body.insufficient_count).toBe(3);
        const loc = res.body.pass_summary.find(p => p.assessment_type === 'location_concentration');
        expect(loc).toMatchObject({ count: 3, insufficient: 2 });
        expect(loc.detail).toMatch(/^1 passing check and 2 with an insufficient sample in the window · /);
    });
});

describe('npm run bias:window (scripts/bias-window.js)', () => {
    const { main, parseArgs } = require('../../scripts/bias-window');

    it('rejects unknown arguments', () => {
        expect(() => parseArgs(['--hours', '2'])).toThrow(/unknown argument/);
        expect(parseArgs(['--json'])).toEqual({ json: true });
        expect(parseArgs([])).toEqual({ json: false });
    });

    it('runs one on-demand window and prints a summary (or JSON)', async () => {
        await registerBias('1.5.0');
        const lines = [];
        const s = await main([], { out: l => lines.push(l) });
        expect(s).toMatchObject({ version: 'bias@1.5.0', window_hours: 24, posts_assessed: 0, violations_found: 0 });
        expect(lines[0]).toMatch(/^bias window .* \(bias@1\.5\.0\): .* 0 posts, 0 violation\(s\)$/);
        expect(lines.slice(1)).toEqual([
            '  location_concentration: insufficient_sample (0.000)',
            '  platform_sentiment_parity: insufficient_sample (0.000)',
            '  negative_dominance: insufficient_sample (0.000)',
        ]);
        const json = [];
        await main(['--json'], { out: l => json.push(l) });
        expect(JSON.parse(json[0]).checks).toHaveLength(3);
        const runs = await dbAll(`SELECT triggered_by FROM bias_window_runs`);
        expect(runs.map(r => r.triggered_by)).toEqual(['on_demand', 'on_demand']);
    });
});
