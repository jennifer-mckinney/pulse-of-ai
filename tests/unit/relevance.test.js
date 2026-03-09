// tests/unit/relevance.test.js
// Tests for src/pipeline/relevance.js
// Covers: AI-relevance keyword scoring (pure), audit log write, DB persistence.

'use strict';

const { dbGet, dbAll, dbRun } = require('../../src/db/connection');
const {
    computeRelevance,   // pure: text → { score, matchedKeywords }
    saveRelevance,      // impure: persists relevance_results + decision_audit_log
} = require('../../src/pipeline/relevance');

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function insertSource() {
    const row = await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category)
         VALUES ('rel-test-src', 'Rel Test', 'reddit', 'social')
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
    );
    return row.id;
}

async function insertPost(content = 'Machine learning is improving natural language processing') {
    const crypto = require('crypto');
    const hash   = crypto.createHash('sha256').update(content).digest('hex');
    const srcId  = await insertSource();
    const row    = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (source_id, external_id) DO UPDATE SET content = EXCLUDED.content
         RETURNING id`,
        [srcId, `rel-${hash.slice(0, 12)}`, content, hash],
    );
    return row.id;
}

async function insertJob() {
    const row = await dbRun(
        `INSERT INTO processing_jobs (triggered_by, status) VALUES ('rel-test', 'running') RETURNING id`,
    );
    return row.id;
}

async function relevanceMvId() {
    const row = await dbRun(
        `INSERT INTO methodology_versions
            (component, version, model_name, config, justification)
         VALUES ('relevance', '1.0.0', 'keyword-relevance-v1',
                 '{"min_score":0.1}'::jsonb,
                 'Keyword overlap score against 20-term AI domain lexicon.')
         ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component
         RETURNING id`,
    );
    return row.id;
}

// ─── computeRelevance() ───────────────────────────────────────────────────────

describe('computeRelevance()', () => {
    it('returns a score between 0 and 1 for any input', () => {
        const r = computeRelevance('neural network deep learning transformer model');
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
    });

    it('returns a high score for clearly AI-relevant text', () => {
        const r = computeRelevance(
            'The large language model uses deep learning and neural networks for NLP tasks',
        );
        // 4 matches (large language model, deep learning, neural network, nlp) / 20 = 0.2
        expect(r.score).toBeGreaterThan(0.15);
        expect(r.matchedKeywords.length).toBeGreaterThan(0);
    });

    it('returns zero score for completely unrelated text', () => {
        const r = computeRelevance('The quick brown fox jumps over the lazy dog');
        expect(r.score).toBe(0);
        expect(r.matchedKeywords).toHaveLength(0);
    });

    it('returns expected shape', () => {
        const r = computeRelevance('AI and machine learning');
        expect(r).toMatchObject({
            score:           expect.any(Number),
            matchedKeywords: expect.any(Array),
        });
    });

    it('handles empty string without throwing', () => {
        expect(() => computeRelevance('')).not.toThrow();
        const r = computeRelevance('');
        expect(r.score).toBe(0);
    });

    it('is case-insensitive', () => {
        const lower = computeRelevance('machine learning is advancing');
        const upper = computeRelevance('MACHINE LEARNING IS ADVANCING');
        expect(lower.score).toBe(upper.score);
        expect(lower.matchedKeywords).toEqual(upper.matchedKeywords);
    });

    it('does not double-count the same keyword appearing multiple times', () => {
        const once  = computeRelevance('AI is great');
        const twice = computeRelevance('AI is great and AI is wonderful');
        // Score is based on unique matched keywords, not raw occurrences
        expect(twice.score).toBe(once.score);
        expect(twice.matchedKeywords).toHaveLength(once.matchedKeywords.length);
    });

    it('score is capped at 1.0 even for very AI-dense text', () => {
        const dense = 'AI machine learning deep learning neural network LLM NLP transformer GPT BERT';
        const r = computeRelevance(dense);
        expect(r.score).toBeLessThanOrEqual(1.0);
    });
});

// ─── saveRelevance() ──────────────────────────────────────────────────────────

describe('saveRelevance()', () => {
    it('writes a row to relevance_results', async () => {
        const postId = await insertPost('Large language models use transformers for NLP tasks');
        const jobId  = await insertJob();
        const mvId   = await relevanceMvId();

        await saveRelevance(postId, jobId, mvId);

        const row = await dbGet(
            'SELECT * FROM relevance_results WHERE raw_post_id = $1',
            [postId],
        );
        expect(row).toBeDefined();
        expect(row.raw_post_id).toBe(postId);
        expect(row.score).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(row.matched_keywords)).toBe(true);
    });

    it('writes a decision_audit_log row with decision_type="relevance"', async () => {
        const postId = await insertPost('Neural networks power modern AI research');
        const jobId  = await insertJob();
        const mvId   = await relevanceMvId();

        await saveRelevance(postId, jobId, mvId);

        const audit = await dbGet(
            `SELECT * FROM decision_audit_log WHERE raw_post_id = $1 AND decision_type = 'relevance'`,
            [postId],
        );
        expect(audit).toBeDefined();
        expect(audit.model_name).toMatch(/keyword-relevance/i);
        expect(audit.input_hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('links relevance_results.audit_id to the decision_audit_log row', async () => {
        const postId = await insertPost('Deep learning research advances AI capabilities');
        const jobId  = await insertJob();
        const mvId   = await relevanceMvId();

        await saveRelevance(postId, jobId, mvId);

        const relRow   = await dbGet('SELECT audit_id FROM relevance_results WHERE raw_post_id = $1', [postId]);
        const auditRow = await dbGet('SELECT id FROM decision_audit_log WHERE raw_post_id = $1 AND decision_type = $2', [postId, 'relevance']);
        expect(relRow.audit_id).toBe(auditRow.id);
    });

    it('is idempotent: second call does not insert a duplicate row', async () => {
        const postId = await insertPost('GPT and BERT are transformer-based language models');
        const jobId  = await insertJob();
        const mvId   = await relevanceMvId();

        await saveRelevance(postId, jobId, mvId);
        await saveRelevance(postId, jobId, mvId);

        const rows = await dbAll('SELECT id FROM relevance_results WHERE raw_post_id = $1', [postId]);
        expect(rows).toHaveLength(1);
    });

    it('returns the saved relevance_results row', async () => {
        const postId = await insertPost('Reinforcement learning from human feedback trains LLMs');
        const jobId  = await insertJob();
        const mvId   = await relevanceMvId();

        const result = await saveRelevance(postId, jobId, mvId);
        expect(result).toBeDefined();
        expect(result.raw_post_id).toBe(postId);
    });
});
