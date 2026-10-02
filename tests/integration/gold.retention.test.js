// tests/integration/gold.retention.test.js
// Relevance-accuracy Stage 0 (P3), against the real test DB: when retention
// removes a post's text (src/collectors/retention.js), the post's gold-set
// rows are erased in the SAME transaction (migration 070, gold_erase_post), so
// the immutable gold tables never keep a link or a fingerprint of removed text.

'use strict';

const db = require('../../src/db/connection');
const { seedSources } = require('../../scripts/seed');
const retention = require('../../src/collectors/retention');
const { insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

const H = (c) => c.repeat(64);

async function goldItem(postId, hash) {
    const id = (await db.dbRun(
        `INSERT INTO relevance_gold_items (sample_id, raw_post_id, input_hash, category, scope, decision, script, stratum,
             stratum_population, stratum_sample_size, stratum_weight, design_weight, draw_rank, sampler_version, seed)
         VALUES ('gold-ret', $1, $2, 'forums', 'ai', 'relevant', 'latin', 'forums|ai|relevant|latin', 4, 2, 1, 2, $3, '1.0.0', 's')
         RETURNING id`,
        [postId, hash, H(hash[0])],
    )).id;
    await db.dbRun(
        `INSERT INTO relevance_gold_labels (item_id, label, labeller, method, codebook_version, input_hash, note)
         VALUES ($1, 'AI_CENTRAL', 'ann', 'human', '1.0.0', $2, 'short note')`,
        [id, hash],
    );
    return id;
}

describe('retention erases the gold rows of a post whose text it removes', () => {
    it('blanking a Reddit post erases its gold item and label fingerprint and note, and leaves other posts alone', async () => {
        await seedSources();
        const reddit = (await db.dbGet("SELECT id FROM data_sources WHERE name = 'reddit'")).id;
        const mv = await insertMethodologyVersions();
        const jobId = await insertJob();
        const mk = (n) => insertPostWithFullPipeline(reddit, jobId, mv, {
            externalId: `data-api:t3_${n}`, collectedAt: new Date(Date.now() - 49 * 3600000), location: '',
        });
        const gone = await mk('aaa');
        const kept = await mk('bbb');
        const goneItem = await goldItem(gone, H('a'));
        const keptItem = await goldItem(kept, H('b'));

        const changed = await retention.blankPosts('reddit', [gone], { reason: 'test removal' });
        expect(changed).toEqual([gone]);

        const g = await db.dbGet('SELECT raw_post_id, input_hash, erased_at FROM relevance_gold_items WHERE id = $1', [goneItem]);
        expect(g).toMatchObject({ raw_post_id: null, input_hash: null });
        expect(g.erased_at).toBeTruthy();
        const gl = await db.dbGet('SELECT input_hash, note, label FROM relevance_gold_labels WHERE item_id = $1', [goneItem]);
        expect(gl).toEqual({ input_hash: null, note: null, label: 'AI_CENTRAL' });

        const k = await db.dbGet('SELECT raw_post_id, input_hash FROM relevance_gold_items WHERE id = $1', [keptItem]);
        expect(k).toEqual({ raw_post_id: kept, input_hash: H('b') });
    });
});
