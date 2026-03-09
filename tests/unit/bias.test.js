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
});
