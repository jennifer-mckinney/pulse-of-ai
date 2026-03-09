// tests/unit/discourse.test.js
// Tests for src/pipeline/discourse.js
// Covers: DQI scoring (pure), dimension extraction, DB persistence, audit log.
//
// DQI = Deliberative Quality Index (Steenbergen et al. 2003)
// Dimensions:
//   participation    — post is substantive (length > threshold)
//   justification    — contains reasoning connectors (because, therefore, etc.)
//   respectfulness   — absence of hostile/disrespectful language
//   constructiveness — contains solution-oriented language
//   evidence         — cites sources, data, or examples

'use strict';

const { dbGet, dbAll, dbRun } = require('../../src/db/connection');
const {
    computeDQI,     // pure: text → { total, dimensions }
    saveDQI,        // impure: persists discourse_results + decision_audit_log
    DQI_DIMENSIONS, // exported constant: list of dimension names
} = require('../../src/pipeline/discourse');

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function insertSource() {
    const row = await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category)
         VALUES ('dqi-test-src', 'DQI Test', 'reddit', 'social')
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
    );
    return row.id;
}

async function insertPost(content) {
    const crypto = require('crypto');
    const hash   = crypto.createHash('sha256').update(content).digest('hex');
    const srcId  = await insertSource();
    const row    = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (source_id, external_id) DO UPDATE SET content = EXCLUDED.content
         RETURNING id`,
        [srcId, `dqi-${hash.slice(0, 12)}`, content, hash],
    );
    return row.id;
}

async function insertJob() {
    const row = await dbRun(
        `INSERT INTO processing_jobs (triggered_by, status) VALUES ('dqi-test', 'running') RETURNING id`,
    );
    return row.id;
}

async function discourseMvId() {
    const row = await dbRun(
        `INSERT INTO methodology_versions
            (component, version, model_name, config, justification)
         VALUES ('discourse', '1.0.0-DQI', 'dqi-heuristic-v1',
                 '{"dimensions":["participation","justification","respectfulness","constructiveness","evidence"]}'::jsonb,
                 'Deliberative Quality Index (Steenbergen et al. 2003) with NLP extensions.')
         ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component
         RETURNING id`,
    );
    return row.id;
}

// ─── Sample texts ─────────────────────────────────────────────────────────────

const HIGH_QUALITY_POST = `
    I believe AI safety research is critically important because large language models can
    produce unpredictable outputs when deployed at scale. For example, studies from Anthropic
    and DeepMind have shown that RLHF-trained models still exhibit reward hacking behaviours.
    Therefore, we should invest more in interpretability tools and red-teaming exercises.
    This constructive approach would help the community address the root causes of misalignment.
`.trim();

const LOW_QUALITY_POST = 'lol ok';

const HOSTILE_POST = 'You are completely stupid and your AI work is garbage and worthless idiot';

// ─── computeDQI() ─────────────────────────────────────────────────────────────

describe('computeDQI()', () => {
    it('returns a total DQI score between 0 and 1', () => {
        const r = computeDQI(HIGH_QUALITY_POST);
        expect(r.total).toBeGreaterThanOrEqual(0);
        expect(r.total).toBeLessThanOrEqual(1);
    });

    it('returns a higher score for substantive, reasoned text', () => {
        const high = computeDQI(HIGH_QUALITY_POST);
        const low  = computeDQI(LOW_QUALITY_POST);
        expect(high.total).toBeGreaterThan(low.total);
    });

    it('returns the expected shape with all five dimensions', () => {
        const r = computeDQI(HIGH_QUALITY_POST);
        expect(r).toMatchObject({
            total:      expect.any(Number),
            dimensions: expect.objectContaining({
                participation:    expect.any(Number),
                justification:    expect.any(Number),
                respectfulness:   expect.any(Number),
                constructiveness: expect.any(Number),
                evidence:         expect.any(Number),
            }),
        });
    });

    it('DQI_DIMENSIONS lists the five expected dimension names', () => {
        expect(DQI_DIMENSIONS).toEqual(expect.arrayContaining([
            'participation', 'justification', 'respectfulness',
            'constructiveness', 'evidence',
        ]));
        expect(DQI_DIMENSIONS).toHaveLength(5);
    });

    it('participation dimension scores higher for longer substantive posts', () => {
        const long  = computeDQI(HIGH_QUALITY_POST);
        const short = computeDQI('AI is good.');
        expect(long.dimensions.participation).toBeGreaterThan(short.dimensions.participation);
    });

    it('justification dimension detects reasoning connectors', () => {
        const r = computeDQI('We should do this because the evidence shows it works therefore results improve');
        expect(r.dimensions.justification).toBeGreaterThan(0);
    });

    it('respectfulness dimension penalises hostile text', () => {
        const respectful = computeDQI(HIGH_QUALITY_POST);
        const hostile    = computeDQI(HOSTILE_POST);
        expect(respectful.dimensions.respectfulness).toBeGreaterThan(hostile.dimensions.respectfulness);
    });

    it('evidence dimension detects source citations', () => {
        const withEvidence    = computeDQI('According to the study, AI systems show improved accuracy. Research indicates this trend');
        const withoutEvidence = computeDQI('I think AI is great and should be used more everywhere');
        expect(withEvidence.dimensions.evidence).toBeGreaterThan(withoutEvidence.dimensions.evidence);
    });

    it('handles empty string without throwing', () => {
        expect(() => computeDQI('')).not.toThrow();
        const r = computeDQI('');
        expect(r.total).toBe(0);
    });

    it('total is the average of all five dimension scores', () => {
        const r = computeDQI(HIGH_QUALITY_POST);
        const avg = Object.values(r.dimensions).reduce((a, b) => a + b, 0) / 5;
        expect(r.total).toBeCloseTo(avg, 6);
    });
});

// ─── saveDQI() ────────────────────────────────────────────────────────────────

describe('saveDQI()', () => {
    it('writes a row to discourse_results', async () => {
        const postId = await insertPost(HIGH_QUALITY_POST);
        const jobId  = await insertJob();
        const mvId   = await discourseMvId();

        await saveDQI(postId, jobId, mvId);

        const row = await dbGet('SELECT * FROM discourse_results WHERE raw_post_id = $1', [postId]);
        expect(row).toBeDefined();
        expect(row.raw_post_id).toBe(postId);
        expect(typeof row.dqi_total).toBe('number');
        expect(row.dimensions).toBeDefined(); // JSONB
    });

    it('writes a decision_audit_log row with decision_type="discourse"', async () => {
        const postId = await insertPost('AI safety research is important because alignment is hard');
        const jobId  = await insertJob();
        const mvId   = await discourseMvId();

        await saveDQI(postId, jobId, mvId);

        const audit = await dbGet(
            `SELECT * FROM decision_audit_log WHERE raw_post_id = $1 AND decision_type = 'discourse'`,
            [postId],
        );
        expect(audit).toBeDefined();
        expect(audit.input_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is idempotent: second call does not insert duplicate', async () => {
        const postId = await insertPost(HIGH_QUALITY_POST + ' extra unique text here');
        const jobId  = await insertJob();
        const mvId   = await discourseMvId();

        await saveDQI(postId, jobId, mvId);
        await saveDQI(postId, jobId, mvId);

        const rows = await dbAll('SELECT id FROM discourse_results WHERE raw_post_id = $1', [postId]);
        expect(rows).toHaveLength(1);
    });

    it('returns the saved discourse_results row', async () => {
        const postId = await insertPost('Because AI advances quickly, we need safety guardrails therefore alignment research matters');
        const jobId  = await insertJob();
        const mvId   = await discourseMvId();

        const result = await saveDQI(postId, jobId, mvId);
        expect(result).toBeDefined();
        expect(result.raw_post_id).toBe(postId);
    });
});
