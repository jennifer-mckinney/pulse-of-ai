// tests/integration/replay.test.js
// End-to-end check of the audit receipt's reproduce command (P1-4):
// a post is scored by the REAL pipeline save* functions into the test DB,
// then `scripts/replay.js` main() loads it back through the real connection
// helpers and must reproduce every stage (PASS), while a tampered stored
// output must be reported as DIVERGENCE.

'use strict';

const crypto = require('crypto');
const db = require('../../src/db/connection');
const { saveSentiment } = require('../../src/pipeline/sentiment');
const { saveRelevance } = require('../../src/pipeline/relevance');
const { saveDQI } = require('../../src/pipeline/discourse');
const { main } = require('../../scripts/replay');
const { insertSource, insertJob, insertMethodologyVersions } = require('./helpers');

const CONTENT = 'Deep learning research shows transformer models should improve '
    + 'because the evidence is strong, therefore we recommend careful evaluation.';

async function seedScoredPost() {
    const sourceId = await insertSource('replay-src');
    const jobId = await insertJob();
    const mv = await insertMethodologyVersions();
    const post = await db.dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location)
         VALUES ($1, 'replay-1', $2, $3, 'Paris') RETURNING id`,
        [sourceId, CONTENT, crypto.createHash('sha256').update(CONTENT).digest('hex')],
    );
    await saveSentiment(post.id, jobId, mv.sentimentMvId);
    await saveRelevance(post.id, jobId, mv.relevanceMvId);
    await saveDQI(post.id, jobId, mv.discourseMvId);
    return post.id;
}

function capture() {
    const lines = { out: [], err: [] };
    return { lines, io: { db, out: l => lines.out.push(l), err: l => lines.err.push(l) } };
}

describe('npm run replay -- --post <id> (scripts/replay.js)', () => {
    it('reproduces every stage of a pipeline-scored post: PASS, exit 0', async () => {
        const postId = await seedScoredPost();
        const { lines, io } = capture();
        const code = await main(['--post', postId], io);
        expect(lines.err).toEqual([]);
        expect(code).toBe(0);
        const text = lines.out.join('\n');
        expect(text).toContain(`Replay — post ${postId}`);
        expect(text).toContain('[PASS] sentiment (afinn-sentiment-v5 @ methodology 1.0.0)');
        expect(text).toContain('[PASS] relevance (keyword-relevance-v1 @ methodology 1.0.0)');
        expect(text).toContain('[PASS] discourse (dqi-heuristic-v1 @ methodology 1.0.0-DQI)');
        expect(text).toContain('[NOT RE-RUNNABLE] bias — out of per-post replay scope');
        expect(lines.out[lines.out.length - 1]).toBe('RESULT: PASS');
    });

    it('reports DIVERGENCE (exit 1) when a stored output no longer matches the code', async () => {
        const postId = await seedScoredPost();
        // Simulate a stored output the current scorer does not produce.
        await db.dbRun(
            `UPDATE decision_audit_log
             SET output = jsonb_set(output, '{indicator}', '"negative"')
             WHERE raw_post_id = $1 AND decision_type = 'sentiment'`,
            [postId],
        );
        const { lines, io } = capture();
        const code = await main(['--post', postId], io);
        expect(code).toBe(1);
        const text = lines.out.join('\n');
        expect(text).toContain('[DIVERGENCE] sentiment');
        expect(text).toMatch(/indicator: stored "negative" ≠ replayed "positive"/);
        expect(lines.out[lines.out.length - 1]).toBe('RESULT: DIVERGENCE');
    });

    it('exits 2 for a post that does not exist', async () => {
        const { lines, io } = capture();
        const code = await main(['--post', '00000000-0000-4000-8000-000000000000'], io);
        expect(code).toBe(2);
        expect(lines.err[0]).toMatch(/not found/);
    });
});
