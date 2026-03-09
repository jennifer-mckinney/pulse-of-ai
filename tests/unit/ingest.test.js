// tests/unit/ingest.test.js
// Tests for src/pipeline/ingest.js
// Covers: post normalisation, deduplication, full pipeline orchestration.
// ingest.js is the collect → process → store orchestrator.

'use strict';

const { dbGet, dbAll, dbRun } = require('../../src/db/connection');
const {
    normalisePost,      // pure: raw API payload → normalised row fields
    ingestPost,         // orchestrates: normalise → dedup → sentiment → relevance → discourse
    ingestBatch,        // ingest multiple posts; returns counts
} = require('../../src/pipeline/ingest');

// ─── Test helpers ─────────────────────────────────────────────────────────────

async function insertSource(name = 'ingest-test-reddit') {
    const row = await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category)
         VALUES ($1, 'Ingest Test', 'reddit', 'social')
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name],
    );
    return row.id;
}

async function insertJob() {
    const row = await dbRun(
        `INSERT INTO processing_jobs (triggered_by, status) VALUES ('ingest-test', 'running') RETURNING id`,
    );
    return row.id;
}

/** Insert all three methodology_version rows required by the pipeline. */
async function insertMethodologyVersions() {
    const rows = await Promise.all([
        dbRun(`INSERT INTO methodology_versions (component, version, model_name, config, justification)
               VALUES ('sentiment', '1.0.0', 'afinn-sentiment-v5', '{}'::jsonb, 'AFINN')
               ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component
               RETURNING id`),
        dbRun(`INSERT INTO methodology_versions (component, version, model_name, config, justification)
               VALUES ('relevance', '1.0.0', 'keyword-relevance-v1', '{}'::jsonb, 'Keywords')
               ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component
               RETURNING id`),
        dbRun(`INSERT INTO methodology_versions (component, version, model_name, config, justification)
               VALUES ('discourse', '1.0.0-DQI', 'dqi-heuristic-v1', '{}'::jsonb, 'DQI')
               ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component
               RETURNING id`),
    ]);
    return {
        sentimentMvId:  rows[0].id,
        relevanceMvId:  rows[1].id,
        discourseMvId:  rows[2].id,
    };
}

/** A sample raw API payload as returned by a Reddit collector. */
function makeRawPayload(overrides = {}) {
    return {
        id:        overrides.id        || 'abc123',
        title:     overrides.title     || 'AI safety research is making progress',
        selftext:  overrides.selftext  || 'Because deep learning systems are improving, therefore we need alignment research.',
        author:    overrides.author    || 'u/some_user',       // PII — must be stripped
        subreddit: overrides.subreddit || 'MachineLearning',
        score:     overrides.score     || 42,
        created:   overrides.created   || Math.floor(Date.now() / 1000),
    };
}

// ─── normalisePost() ──────────────────────────────────────────────────────────

describe('normalisePost()', () => {
    it('returns content_hash as a 64-char hex string', () => {
        const result = normalisePost(makeRawPayload(), 'reddit');
        expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('strips PII: author/username is not present in the normalised output', () => {
        const result = normalisePost(makeRawPayload(), 'reddit');
        const resultStr = JSON.stringify(result);
        expect(resultStr).not.toContain('u/some_user');
        expect(resultStr).not.toContain('some_user');
    });

    it('concatenates title + selftext for reddit posts', () => {
        const payload = makeRawPayload({ title: 'Hello', selftext: 'World' });
        const result  = normalisePost(payload, 'reddit');
        expect(result.content).toContain('Hello');
        expect(result.content).toContain('World');
    });

    it('sets externalId to the platform post id', () => {
        const result = normalisePost(makeRawPayload({ id: 'xyz999' }), 'reddit');
        expect(result.externalId).toBe('xyz999');
    });

    it('preserves raw_payload without the author field', () => {
        const payload = makeRawPayload();
        const result  = normalisePost(payload, 'reddit');
        expect(result.rawPayload).toBeDefined();
        expect(result.rawPayload.author).toBeUndefined();
        expect(result.rawPayload.subreddit).toBe('MachineLearning');
    });

    it('returns identical contentHash for semantically equivalent content', () => {
        const p1 = makeRawPayload({ title: 'AI safety', selftext: 'is important' });
        const p2 = makeRawPayload({ title: 'AI safety', selftext: 'is important' });
        expect(normalisePost(p1, 'reddit').contentHash)
            .toBe(normalisePost(p2, 'reddit').contentHash);
    });
});

// ─── ingestPost() ────────────────────────────────────────────────────────────

describe('ingestPost()', () => {
    it('creates a raw_posts row', async () => {
        const sourceId = await insertSource();
        const jobId    = await insertJob();
        const mvIds    = await insertMethodologyVersions();

        const payload = makeRawPayload();
        await ingestPost(payload, sourceId, jobId, mvIds);

        const post = await dbGet(
            'SELECT id FROM raw_posts WHERE source_id = $1 AND external_id = $2',
            [sourceId, payload.id],
        );
        expect(post).toBeDefined();
    });

    it('runs sentiment, relevance, and discourse pipeline for each post', async () => {
        const sourceId = await insertSource();
        const jobId    = await insertJob();
        const mvIds    = await insertMethodologyVersions();

        const payload = makeRawPayload({ id: 'pipeline-test-01' });
        await ingestPost(payload, sourceId, jobId, mvIds);

        const post = await dbGet(
            'SELECT id FROM raw_posts WHERE source_id = $1 AND external_id = $2',
            [sourceId, 'pipeline-test-01'],
        );

        const [sentiment, relevance, discourse] = await Promise.all([
            dbGet('SELECT id FROM sentiment_results  WHERE raw_post_id = $1', [post.id]),
            dbGet('SELECT id FROM relevance_results  WHERE raw_post_id = $1', [post.id]),
            dbGet('SELECT id FROM discourse_results  WHERE raw_post_id = $1', [post.id]),
        ]);

        expect(sentiment).toBeDefined();
        expect(relevance).toBeDefined();
        expect(discourse).toBeDefined();
    });

    it('writes to decision_audit_log for all three decision types', async () => {
        const sourceId = await insertSource();
        const jobId    = await insertJob();
        const mvIds    = await insertMethodologyVersions();

        const payload = makeRawPayload({ id: 'audit-test-01' });
        await ingestPost(payload, sourceId, jobId, mvIds);

        const post = await dbGet(
            'SELECT id FROM raw_posts WHERE source_id = $1 AND external_id = $2',
            [sourceId, 'audit-test-01'],
        );
        const auditRows = await dbAll(
            'SELECT decision_type FROM decision_audit_log WHERE raw_post_id = $1',
            [post.id],
        );
        const types = auditRows.map(r => r.decision_type).sort();
        expect(types).toEqual(['discourse', 'relevance', 'sentiment']);
    });

    it('is idempotent: ingesting the same post twice does not duplicate rows', async () => {
        const sourceId = await insertSource();
        const jobId    = await insertJob();
        const mvIds    = await insertMethodologyVersions();

        const payload = makeRawPayload({ id: 'dedup-test-01' });
        await ingestPost(payload, sourceId, jobId, mvIds);
        await ingestPost(payload, sourceId, jobId, mvIds); // second call — same external_id

        const posts = await dbAll(
            'SELECT id FROM raw_posts WHERE source_id = $1 AND external_id = $2',
            [sourceId, 'dedup-test-01'],
        );
        expect(posts).toHaveLength(1);
    });

    it('returns an object indicating the post was new or already existed', async () => {
        const sourceId = await insertSource();
        const jobId    = await insertJob();
        const mvIds    = await insertMethodologyVersions();

        const payload = makeRawPayload({ id: 'result-test-01' });
        const first  = await ingestPost(payload, sourceId, jobId, mvIds);
        const second = await ingestPost(payload, sourceId, jobId, mvIds);

        expect(first.isNew).toBe(true);
        expect(second.isNew).toBe(false);
    });
});

// ─── ingestBatch() ───────────────────────────────────────────────────────────

describe('ingestBatch()', () => {
    it('ingests all posts in a batch and returns total counts', async () => {
        const sourceId = await insertSource();
        const jobId    = await insertJob();
        const mvIds    = await insertMethodologyVersions();

        const payloads = [
            makeRawPayload({ id: 'batch-01', selftext: 'Neural networks are advancing AI research' }),
            makeRawPayload({ id: 'batch-02', selftext: 'Machine learning models are becoming more capable' }),
            makeRawPayload({ id: 'batch-03', selftext: 'Simple post with no AI keywords here' }),
        ];

        const result = await ingestBatch(payloads, sourceId, jobId, mvIds);

        expect(result.total).toBe(3);
        expect(result.newPosts).toBe(3);
        expect(result.skipped).toBe(0);
    });

    it('counts duplicates as skipped in the batch result', async () => {
        const sourceId = await insertSource();
        const jobId    = await insertJob();
        const mvIds    = await insertMethodologyVersions();

        const payload = makeRawPayload({ id: 'batch-dup-01' });
        await ingestPost(payload, sourceId, jobId, mvIds); // pre-existing

        const result = await ingestBatch([payload], sourceId, jobId, mvIds);
        expect(result.skipped).toBe(1);
        expect(result.newPosts).toBe(0);
    });
});
