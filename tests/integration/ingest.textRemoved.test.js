// tests/integration/ingest.textRemoved.test.js
// PR #22 grumpy H1: a post whose text retention replaced by a removal
// notice is never scored. raw_posts.content is NOT NULL, so the old
// "content already nulled" guard could never fire: a backlogged ingest job
// (or a sweep retry) that ran after blanking scored the NOTICE and wrote
// permanent audit rows describing nothing. Every scoring stage now reads
// text_removed_at and refuses; the ingest worker completes such a job as a
// recorded no-op; the unscored sweep never re-queues a blanked post.

'use strict';

const { dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const { removeTextBatch } = require('../../src/collectors/retention');
const { saveSentiment } = require('../../src/pipeline/sentiment');
const { saveRelevance } = require('../../src/pipeline/relevance');
const { saveDQI } = require('../../src/pipeline/discourse');
const { sweepUnscored } = require('../../src/collectors/sweep');
const { insertSource, insertJob, insertMethodologyVersions } = require('./helpers');

jest.mock('../../src/queues/index', () => ({
    embedQueue: { add: jest.fn().mockResolvedValue({ id: 'embed-x' }) },
}));
const { processIngestJob } = require('../../src/workers/ingest.worker');
const { embedQueue } = require('../../src/queues/index');

let src; let job; let mv;
beforeEach(async () => {
    src = await insertSource('real-news', 'news');
    job = await insertJob('running');
    mv = await insertMethodologyVersions();
});

async function insertPost(content, collectedAt = new Date(Date.now() - 30 * 60 * 1000)) {
    return (await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, collected_at)
         VALUES ($1, $2, $3, md5($3), $4) RETURNING id`,
        [src, `ext-${Math.random()}`, content, collectedAt],
    )).id;
}
function blank(postId) {
    return dbTransaction(client => removeTextBatch(client, 'real-news', [postId], {
        reason: 'test', rule: 'test', performedBy: 'tests/integration/ingest.textRemoved.test.js', platform: false,
    }));
}
const audits = async (postId) => (await dbGet('SELECT COUNT(*)::int AS n FROM decision_audit_log WHERE raw_post_id = $1', [postId])).n;

describe('a blanked post is never scored', () => {
    it('each stage refuses with code TEXT_REMOVED and writes nothing', async () => {
        const id = await insertPost('AI and machine learning news from the lab');
        expect(await blank(id)).toEqual([id]);
        for (const [fn, mvId] of [[saveSentiment, mv.sentimentMvId], [saveRelevance, mv.relevanceMvId], [saveDQI, mv.discourseMvId]]) {
            await expect(fn(id, job, mvId)).rejects.toMatchObject({ code: 'TEXT_REMOVED' });
        }
        expect(await audits(id)).toBe(0);
    });

    it('the ingest worker completes the job as a recorded no-op and queues no embedding', async () => {
        const id = await insertPost('AI and machine learning news from the lab');
        await blank(id);
        await require('../../scripts/seed').seedMethodology();
        const out = await processIngestJob({ data: { rawPostId: id, sourceId: src, jobId: null } });
        expect(out).toMatchObject({ rawPostId: id, skipped: true, reason: 'text_removed' });
        expect(await audits(id)).toBe(0);
        expect(embedQueue.add).not.toHaveBeenCalled();
    });

    it('the unscored sweep never re-queues a blanked post, but still re-queues a live one', async () => {
        const gone = await insertPost('AI news that was removed');
        const live = await insertPost('AI news still stored');
        await blank(gone);
        const queued = [];
        const r = await sweepUnscored({ enqueue: async (data) => { queued.push(data.rawPostId); } });
        expect(queued).toEqual([live]);
        expect(r.found).toBe(1);
    });
});
