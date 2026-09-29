// tests/unit/bias.test.js
// Tests for src/pipeline/bias.js
// Covers: location concentration, platform sentiment parity, negative dominance.
// Thresholds are read from methodology_versions.config (DB-driven, AI Act compliant).

'use strict';

const { dbGet, dbAll, dbRun } = require('../../src/db/connection');
const {
    runBiasChecks,           // orchestrates all checks for a completed job
    checkLocationConcentration,
    checkPlatformSentimentParity,
    checkNegativeDominance,
} = require('../../src/pipeline/bias');

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function insertSource(name, category = 'social') {
    const row = await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category)
         VALUES ($1, $1, 'reddit', $2)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name, category],
    );
    return row.id;
}

async function insertJob() {
    const row = await dbRun(
        `INSERT INTO processing_jobs (triggered_by, status)
         VALUES ('bias-test', 'running') RETURNING id`,
    );
    return row.id;
}

async function insertMethodologyVersions() {
    const rows = await Promise.all([
        dbRun(`INSERT INTO methodology_versions (component, version, model_name, config, justification)
               VALUES ('sentiment',  '1.0.0',     'afinn-sentiment-v5',   '{}'::jsonb, 'AFINN')
               ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component RETURNING id`),
        dbRun(`INSERT INTO methodology_versions (component, version, model_name, config, justification)
               VALUES ('relevance',  '1.0.0',     'keyword-relevance-v1', '{}'::jsonb, 'Keywords')
               ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component RETURNING id`),
        dbRun(`INSERT INTO methodology_versions (component, version, model_name, config, justification)
               VALUES ('discourse',  '1.0.0-DQI', 'dqi-heuristic-v1',    '{}'::jsonb, 'DQI')
               ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component RETURNING id`),
    ]);
    return { sentimentMvId: rows[0].id, relevanceMvId: rows[1].id, discourseMvId: rows[2].id };
}

/** Insert a bias methodology_version with configurable thresholds. */
async function insertBiasMv(config = {}) {
    const defaults = {
        location_concentration_max: 0.60,
        platform_parity_max_diff:   0.30,
        negative_dominance_max:     0.70,
    };
    const row = await dbRun(
        `INSERT INTO methodology_versions (component, version, model_name, config, justification)
         VALUES ('bias', '1.0.0', 'bias-heuristic-v1', $1::jsonb,
                 'Bias thresholds: location max 60%, platform diff max 30%, negative max 70%.')
         ON CONFLICT (component, version) DO UPDATE SET config = EXCLUDED.config
         RETURNING id`,
        [JSON.stringify({ ...defaults, ...config })],
    );
    return row.id;
}

/**
 * Insert a raw_post + sentiment_result pair directly.
 * Bypasses the full ingest pipeline for speed — bias tests only need the aggregated rows.
 */
async function insertPostWithSentiment(sourceId, jobId, sentimentMvId, {
    location    = null,
    indicator   = 'positive',
    comparative = 0.5,
    externalId  = null,
} = {}) {
    const crypto = require('crypto');
    const content = `Test post ${externalId || Math.random()}`;
    const hash    = crypto.createHash('sha256').update(content).digest('hex');
    const extId   = externalId || hash.slice(0, 16);

    const post = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_id, external_id) DO UPDATE SET content = EXCLUDED.content
         RETURNING id`,
        [sourceId, extId, content, hash, location],
    );

    // Write audit log row first (required FK for sentiment_results)
    const audit = await dbRun(
        `INSERT INTO decision_audit_log
            (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output)
         VALUES ($1, $2, $3, 'sentiment', 'afinn-sentiment-v5', $4, $5::jsonb)
         RETURNING id`,
        [post.id, jobId, sentimentMvId, hash, JSON.stringify({ indicator, comparative })],
    );

    await dbRun(
        `INSERT INTO sentiment_results
            (raw_post_id, audit_id, score, comparative, indicator, positive_words, negative_words, token_count)
         VALUES ($1, $2, $3, $4, $5, '{}', '{}', 5)`,
        [post.id, audit.id, comparative * 10, comparative, indicator],
    );

    return post.id;
}

// ─── checkLocationConcentration() ────────────────────────────────────────────

describe('checkLocationConcentration()', () => {
    it('returns no violation when no single location dominates', async () => {
        const srcId  = await insertSource('loc-test-src-1');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        // 5 posts spread across 3 cities — max share = 2/5 = 0.40 (below 0.60 threshold)
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'London',        externalId: 'lc1' });
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'London',        externalId: 'lc2' });
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'Berlin',        externalId: 'lc3' });
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'Tokyo',         externalId: 'lc4' });
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'Tokyo',         externalId: 'lc5' });

        const result = await checkLocationConcentration(jobId, biasMv);
        expect(result.isViolation).toBe(false);
        expect(result.metricValue).toBeCloseTo(0.4, 2);
    });

    it('detects violation when one location exceeds the threshold', async () => {
        const srcId  = await insertSource('loc-test-src-2');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        // 8/10 posts from San Francisco = 0.80 > 0.60 threshold
        for (let i = 0; i < 8; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'San Francisco', externalId: `sf-${i}` });
        }
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'London', externalId: 'lo-1' });
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'London', externalId: 'lo-2' });

        const result = await checkLocationConcentration(jobId, biasMv);
        expect(result.isViolation).toBe(true);
        expect(result.groupValue).toBe('San Francisco');
        expect(result.metricValue).toBeCloseTo(0.8, 2);
    });

    it('writes a bias_assessments row when a violation is found', async () => {
        const srcId  = await insertSource('loc-test-src-3');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        for (let i = 0; i < 7; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'New York', externalId: `ny-${i}` });
        }
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'Paris', externalId: 'pa-1' });

        await checkLocationConcentration(jobId, biasMv);

        const assessment = await dbGet(
            `SELECT * FROM bias_assessments WHERE job_id = $1 AND assessment_type = 'location_concentration'`,
            [jobId],
        );
        expect(assessment).toBeDefined();
        expect(assessment.is_violation).toBe(true);
        expect(assessment.group_field).toBe('location');
    });

    it('writes an alert_events row when a violation is found', async () => {
        const srcId  = await insertSource('loc-test-src-4');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        for (let i = 0; i < 7; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'Seoul', externalId: `se-${i}` });
        }
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'Lagos', externalId: 'lag-1' });

        await checkLocationConcentration(jobId, biasMv);

        const alert = await dbGet(
            `SELECT * FROM alert_events WHERE alert_type = 'location_concentration'`,
        );
        expect(alert).toBeDefined();
        expect(['warning', 'critical']).toContain(alert.severity);
    });

    it('handles zero located posts gracefully', async () => {
        const srcId  = await insertSource('loc-test-src-5');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        // Insert posts WITHOUT locations (location: null)
        for (let i = 0; i < 5; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { externalId: `no-loc-${i}` });
        }

        const result = await checkLocationConcentration(jobId, biasMv);
        expect(result.isViolation).toBe(false);
        expect(result.metricValue).toBe(0);
        expect(result.groupValue).toBeNull();

        // Verify assessment was written with default values
        const assessment = await dbGet(
            `SELECT * FROM bias_assessments WHERE job_id = $1 AND assessment_type = 'location_concentration'`,
            [jobId],
        );
        expect(assessment).toBeDefined();
        expect(assessment.is_violation).toBe(false);
        expect(assessment.group_value).toBe('none');
    });
});

// ─── checkPlatformSentimentParity() ──────────────────────────────────────────

describe('checkPlatformSentimentParity()', () => {
    it('returns no violation when platform sentiments are similar', async () => {
        const src1   = await insertSource('parity-src-reddit', 'social');
        const src2   = await insertSource('parity-src-news',   'news');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        // Both sources near comparative=0.2 — diff well below 0.30
        for (let i = 0; i < 3; i++) {
            await insertPostWithSentiment(src1, jobId, mvIds.sentimentMvId, { comparative: 0.20, externalId: `r-${i}` });
            await insertPostWithSentiment(src2, jobId, mvIds.sentimentMvId, { comparative: 0.25, externalId: `n-${i}` });
        }

        const result = await checkPlatformSentimentParity(jobId, biasMv);
        expect(result.isViolation).toBe(false);
    });

    it('detects violation when two platforms have very different avg sentiment', async () => {
        const src1   = await insertSource('parity-src-pos', 'social');
        const src2   = await insertSource('parity-src-neg', 'academic');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        // Source 1 avg ~ +0.80, source 2 avg ~ +0.10 → diff = 0.70 > 0.30 threshold
        for (let i = 0; i < 3; i++) {
            await insertPostWithSentiment(src1, jobId, mvIds.sentimentMvId, { comparative:  0.80, externalId: `pos-${i}` });
            await insertPostWithSentiment(src2, jobId, mvIds.sentimentMvId, { comparative:  0.10, externalId: `neg-${i}` });
        }

        const result = await checkPlatformSentimentParity(jobId, biasMv);
        expect(result.isViolation).toBe(true);
        expect(result.metricValue).toBeGreaterThan(0.30);
    });
});

// ─── checkNegativeDominance() ─────────────────────────────────────────────────

describe('checkNegativeDominance()', () => {
    it('returns no violation when negative posts are below threshold', async () => {
        const srcId  = await insertSource('neg-dom-src-1');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        // 2/5 negative = 0.40, below 0.70 threshold
        for (let i = 0; i < 3; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { indicator: 'positive', externalId: `pos-${i}` });
        }
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { indicator: 'negative', externalId: 'neg-1' });
        await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { indicator: 'negative', externalId: 'neg-2' });

        const result = await checkNegativeDominance(jobId, biasMv);
        expect(result.isViolation).toBe(false);
        expect(result.metricValue).toBeCloseTo(0.4, 2);
    });

    it('detects violation when negative posts exceed threshold', async () => {
        const srcId  = await insertSource('neg-dom-src-2');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        // 8/10 negative = 0.80, above 0.70 threshold
        for (let i = 0; i < 8; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { indicator: 'negative', externalId: `neg-${i}` });
        }
        for (let i = 0; i < 2; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { indicator: 'positive', externalId: `pos-${i}` });
        }

        const result = await checkNegativeDominance(jobId, biasMv);
        expect(result.isViolation).toBe(true);
        expect(result.metricValue).toBeCloseTo(0.8, 2);
    });

    it('handles zero posts with sentiment gracefully', async () => {
        const srcId  = await insertSource('neg-dom-src-3');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        // Job exists but has no posts (neither positive nor negative)
        // checkNegativeDominance queries for posts grouped by indicator — should find zero
        const result = await checkNegativeDominance(jobId, biasMv);
        expect(result.isViolation).toBe(false);
        expect(result.metricValue).toBe(0);

        // Verify assessment was written with default values
        const assessment = await dbGet(
            `SELECT * FROM bias_assessments WHERE job_id = $1 AND assessment_type = 'negative_dominance'`,
            [jobId],
        );
        expect(assessment).toBeDefined();
        expect(assessment.is_violation).toBe(false);
        expect(assessment.group_value).toBe('all');
    });
});

// ─── runBiasChecks() — integration of all checks ─────────────────────────────

describe('runBiasChecks()', () => {
    it('runs all three checks and returns a combined summary', async () => {
        const srcId  = await insertSource('full-bias-src');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        for (let i = 0; i < 3; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, {
                location: 'London', indicator: 'positive', externalId: `full-${i}`,
            });
        }

        const summary = await runBiasChecks(jobId, biasMv);

        expect(summary).toMatchObject({
            jobId,
            checksRun:       expect.any(Number),
            violationsFound: expect.any(Number),
            results:         expect.any(Array),
        });
        expect(summary.checksRun).toBe(3);
        expect(summary.results).toHaveLength(3);
    });

    it('violationsFound counts only the checks that triggered', async () => {
        const srcId  = await insertSource('violation-count-src');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();

        // Force negative dominance violation only (8/10 negative)
        for (let i = 0; i < 8; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, {
                location: 'London', indicator: 'negative', externalId: `vn-${i}`,
            });
        }
        for (let i = 0; i < 2; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, {
                location: 'Paris', indicator: 'positive', externalId: `vp-${i}`,
            });
        }

        const summary = await runBiasChecks(jobId, biasMv);
        expect(summary.violationsFound).toBeGreaterThanOrEqual(1);
    });

    // PR #8 review / migration 010: every assessment row records the exact
    // bias methodology version that produced it, so receipts and history
    // never relabel old assessments with a newer version's metadata.
    it('records methodology_version_id = biasMvId on every assessment row (empty and non-empty jobs)', async () => {
        const srcId  = await insertSource('lineage-src');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();
        for (let i = 0; i < 3; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, {
                location: 'London', indicator: 'positive', externalId: `lin-${i}`,
            });
        }
        await runBiasChecks(jobId, biasMv);

        const emptyJob = await insertJob();
        await runBiasChecks(emptyJob, biasMv);   // exercises the no-data branches

        const rows = await dbAll(
            'SELECT job_id, methodology_version_id FROM bias_assessments WHERE job_id = ANY($1)',
            [[jobId, emptyJob]],
        );
        expect(rows.length).toBe(6);
        expect(rows.every(r => r.methodology_version_id === biasMv)).toBe(true);
    });
});

// ─── D3: publisher-located posts (bias@1.2.0) ────────────────────────────────

describe('checkLocationConcentration() — D3 publisher exclusion (bias@1.2.0)', () => {
    async function setBasis(postId, basis) {
        await dbRun(`UPDATE raw_posts SET raw_payload = jsonb_build_object('location_basis', $2::text) WHERE id = $1`, [postId, basis]);
    }

    it('excludes location_basis publisher posts when the version lists it, and records how many', async () => {
        const srcId  = await insertSource('d3-src');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv({ location_basis_excluded: ['publisher'] });

        // 8 London posts placed at the PUBLISHER's city, 2 content-located
        // posts in Berlin and 2 in Tokyo: with the publisher posts London
        // would be 8/12 = 0.67 (> 0.60); without them nothing dominates.
        for (let i = 0; i < 8; i++) {
            const id = await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'London', externalId: `pub-${i}` });
            await setBasis(id, 'publisher');
        }
        for (const [city, n] of [['Berlin', 2], ['Tokyo', 2]]) {
            for (let i = 0; i < n; i++) {
                const id = await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: city, externalId: `${city}-${i}` });
                await setBasis(id, 'content');
            }
        }

        const result = await checkLocationConcentration(jobId, biasMv);
        expect(result.isViolation).toBe(false);
        expect(result.metricValue).toBeCloseTo(0.5, 5);
        const a = await dbGet(`SELECT evidence FROM bias_assessments WHERE job_id = $1 AND assessment_type = 'location_concentration'`, [jobId]);
        expect(a.evidence).toMatchObject({ total: 4, excluded_location_bases: ['publisher'], excluded_posts: 8 });
        expect(a.evidence.rows.map(r => r.location).sort()).toEqual(['Berlin', 'Tokyo']);
        expect(await dbGet(`SELECT 1 FROM alert_events WHERE alert_type = 'location_concentration'`)).toBeUndefined();
    });

    it('a job of only publisher-located posts has no located sample (no alert)', async () => {
        const srcId  = await insertSource('d3-src-2');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv({ location_basis_excluded: ['publisher'] });
        for (let i = 0; i < 5; i++) {
            const id = await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'London', externalId: `p-${i}` });
            await setBasis(id, 'publisher');
        }
        const result = await checkLocationConcentration(jobId, biasMv);
        expect(result).toEqual({ isViolation: false, metricValue: 0, groupValue: null });
        const a = await dbGet(`SELECT group_value, evidence FROM bias_assessments WHERE job_id = $1`, [jobId]);
        expect(a.group_value).toBe('none');
        expect(a.evidence.excluded_posts).toBe(5);
    });

    it('an older version without the list still counts publisher posts (replays of bias@1.1.0 jobs are unchanged)', async () => {
        const srcId  = await insertSource('d3-src-3');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv();
        for (let i = 0; i < 4; i++) {
            const id = await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'London', externalId: `o-${i}` });
            await setBasis(id, 'publisher');
        }
        const result = await checkLocationConcentration(jobId, biasMv);
        expect(result).toMatchObject({ isViolation: true, groupValue: 'London', metricValue: 1 });
        const a = await dbGet(`SELECT evidence FROM bias_assessments WHERE job_id = $1`, [jobId]);
        expect(a.evidence.excluded_posts).toBeUndefined();
    });
});

// ─── P10-5: minimum located sample (bias@1.3.0) ──────────────────────────────

describe('checkLocationConcentration() — minimum sample (bias@1.3.0)', () => {
    const { INSUFFICIENT_SAMPLE } = require('../../src/pipeline/bias');

    it('below location_min_sample: "insufficient sample", share stated, no violation, no alert', async () => {
        const srcId  = await insertSource('ms-src');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv({ location_concentration_max: 0.35, location_min_sample: 30 });
        for (let i = 0; i < 12; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: 'London', externalId: `ms-${i}` });
        }
        const result = await checkLocationConcentration(jobId, biasMv);
        expect(result).toMatchObject({ isViolation: false, metricValue: 1, groupValue: INSUFFICIENT_SAMPLE, insufficientSample: true });
        const a = await dbGet(`SELECT group_value, is_violation, severity, evidence FROM bias_assessments WHERE job_id = $1`, [jobId]);
        expect(a).toMatchObject({ group_value: 'insufficient sample', is_violation: false, severity: null });
        expect(a.evidence).toMatchObject({ insufficient_sample: true, min_sample: 30, total: 12, dominantLocation: 'London' });
        expect(await dbGet(`SELECT 1 FROM alert_events`)).toBeUndefined();
    });

    it('at the minimum the check runs normally and can alert', async () => {
        const srcId  = await insertSource('ms-src-2');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const biasMv = await insertBiasMv({ location_concentration_max: 0.35, location_min_sample: 30 });
        for (let i = 0; i < 30; i++) {
            await insertPostWithSentiment(srcId, jobId, mvIds.sentimentMvId, { location: i < 20 ? 'London' : 'Paris', externalId: `mt-${i}` });
        }
        const result = await checkLocationConcentration(jobId, biasMv);
        expect(result.isViolation).toBe(true);
        expect(result.metricValue).toBeCloseTo(20 / 30, 5);
        expect(await dbGet(`SELECT 1 AS ok FROM alert_events WHERE alert_type = 'location_concentration'`)).toEqual({ ok: 1 });
    });
});

// ─── bias@1.4.0: a minimum sample for every check ────────────────────────────

describe('bias@1.4.0 — minimum samples (parity per category, negative dominance, location)', () => {
    const { METHODOLOGY_VERSIONS } = require('../../src/config/methodology-registry');
    const V14 = METHODOLOGY_VERSIONS.find(m => m.component === 'bias' && m.version === '1.4.0').config;
    const mv14 = () => insertBiasMv(V14);

    it('a single-post cycle raises no alert at all', async () => {
        const src = await insertSource('one-post', 'news');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();
        const biasMv = await mv14();
        await insertPostWithSentiment(src, jobId, mvIds.sentimentMvId, { location: 'New York', indicator: 'negative', comparative: -0.5, externalId: 'solo' });
        const r = await runBiasChecks(jobId, biasMv);
        expect(r.violationsFound).toBe(0);
        expect(await dbAll('SELECT id FROM alert_events')).toEqual([]);
        const rows = await dbAll('SELECT assessment_type, group_value FROM bias_assessments WHERE job_id = $1 ORDER BY assessment_type', [jobId]);
        expect(rows).toEqual([
            { assessment_type: 'location_concentration', group_value: 'insufficient sample' },
            { assessment_type: 'negative_dominance', group_value: 'insufficient sample' },
            { assessment_type: 'platform_sentiment_parity', group_value: 'none' },
        ]);
    });

    it('parity compares only categories with >= 10 posts: small categories give "insufficient sample", no alert', async () => {
        const dev = await insertSource('p-dev', 'developer');
        const forums = await insertSource('p-forums', 'forums');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();
        const biasMv = await mv14();
        for (let i = 0; i < 4; i++) await insertPostWithSentiment(dev, jobId, mvIds.sentimentMvId, { comparative: 0.4, externalId: `d${i}` });
        for (let i = 0; i < 3; i++) await insertPostWithSentiment(forums, jobId, mvIds.sentimentMvId, { comparative: -0.1, externalId: `f${i}` });
        const r = await checkPlatformSentimentParity(jobId, biasMv);
        expect(r).toMatchObject({ isViolation: false, insufficientSample: true, groupValue: 'insufficient sample' });
        const a = await dbGet(`SELECT evidence FROM bias_assessments WHERE job_id = $1`, [jobId]);
        expect(a.evidence).toMatchObject({ insufficient_sample: true, min_per_category: 10, compared: [] });
        expect(await dbAll('SELECT id FROM alert_events')).toEqual([]);
    });

    it('parity with >= 10 posts in two categories still alerts on a real gap', async () => {
        const dev = await insertSource('q-dev', 'developer');
        const forums = await insertSource('q-forums', 'forums');
        const tiny = await insertSource('q-tiny', 'news');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();
        const biasMv = await mv14();
        for (let i = 0; i < 10; i++) await insertPostWithSentiment(dev, jobId, mvIds.sentimentMvId, { comparative: 0.4, externalId: `qd${i}` });
        for (let i = 0; i < 10; i++) await insertPostWithSentiment(forums, jobId, mvIds.sentimentMvId, { comparative: -0.1, externalId: `qf${i}` });
        await insertPostWithSentiment(tiny, jobId, mvIds.sentimentMvId, { comparative: -0.9, externalId: 'qt' });
        const r = await checkPlatformSentimentParity(jobId, biasMv);
        expect(r.isViolation).toBe(true);
        expect(r.metricValue).toBeCloseTo(0.5, 5);           // the 1-post news category is not compared
        expect(await dbGet(`SELECT alert_type FROM alert_events`)).toEqual({ alert_type: 'platform_sentiment_parity' });
    });

    it('negative dominance needs >= 30 posts', async () => {
        const src = await insertSource('n-src', 'news');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();
        const biasMv = await mv14();
        for (let i = 0; i < 5; i++) await insertPostWithSentiment(src, jobId, mvIds.sentimentMvId, { indicator: 'negative', comparative: -0.5, externalId: `n${i}` });
        expect(await checkNegativeDominance(jobId, biasMv)).toMatchObject({ isViolation: false, metricValue: 1, insufficientSample: true });
        const job2 = await insertJob();
        for (let i = 0; i < 30; i++) await insertPostWithSentiment(src, job2, mvIds.sentimentMvId, { indicator: 'negative', comparative: -0.5, externalId: `m${i}` });
        expect((await checkNegativeDominance(job2, biasMv)).isViolation).toBe(true);
    });

    it('a 30+ post content-located concentration alerts; publisher-located posts are ignored', async () => {
        const src = await insertSource('l-src', 'news');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();
        const biasMv = await mv14();
        for (let i = 0; i < 40; i++) {
            const id = await insertPostWithSentiment(src, jobId, mvIds.sentimentMvId, { location: 'London', externalId: `pub${i}` });
            await dbRun(`UPDATE raw_posts SET raw_payload = '{"location_basis":"publisher"}'::jsonb WHERE id = $1`, [id]);
        }
        expect((await checkLocationConcentration(jobId, biasMv)).isViolation).toBe(false);
        const job2 = await insertJob();
        for (let i = 0; i < 30; i++) await insertPostWithSentiment(src, job2, mvIds.sentimentMvId, { location: i < 25 ? 'Tokyo' : 'Paris', externalId: `c${i}` });
        expect((await checkLocationConcentration(job2, biasMv)).isViolation).toBe(true);
    });
});
