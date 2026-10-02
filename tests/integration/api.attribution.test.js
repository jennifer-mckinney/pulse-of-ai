// tests/integration/api.attribution.test.js
// K1: every post row the public API serves carries its source credit and the
// validated link back to the original (POST /api/query, GET /api/sentiment/
// latest, GET /api/audit/:id), and GET /api/credits lists the credited sources.
// Demo posts are fictional: no credit, no link. Design:
// docs/research/k1-attribution-design.md.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { dbRun } = require('../../src/db/connection');
const { SITE_NOTICES } = require('../../src/config/attribution');
const {
    insertSource, insertJob, insertMethodologyVersions, insertIngestMethodology,
    insertPostWithFullPipeline,
} = require('./helpers');

async function insertDemoSource(name = 'demo_news', category = 'news') {
    const row = await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category, active)
         VALUES ($1, 'Demo feed (fictional)', 'demo', $2, FALSE)
         RETURNING id`,
        [name, category],
    );
    return row.id;
}

async function seed(slug, category, payload, extra = {}) {
    const src = await insertSource(slug, category);
    const jobId = await insertJob();
    const mvIds = await insertMethodologyVersions();
    const id = await insertPostWithFullPipeline(src, jobId, mvIds, {
        externalId: `k1-${slug}-${Math.random().toString(36).slice(2, 8)}`,
        rawPayload: payload,
        location: 'Midville',
        ...extra,
    });
    return id;
}

describe('K1 attribution: POST /api/query', () => {
    it('serves source_url, credit, published_at and data_origin on a live post', async () => {
        await seed('npr', 'news', { url: 'https://www.npr.org/2026/09/30/story', published_at: '2026-09-30T10:00:00.000Z' });
        const res = await request(app).post('/api/query').send({});
        expect(res.status).toBe(200);
        const row = res.body.results[0];
        expect(row).toEqual(expect.objectContaining({
            source_name: 'npr',
            attribution: 'NPR',                       // unchanged field
            source_url: 'https://www.npr.org/2026/09/30/story',
            published_at: '2026-09-30T10:00:00.000Z',
            data_origin: 'live',
        }));
        expect(row.credit).toEqual(expect.objectContaining({ text: 'NPR', required: true }));
    });

    it('credits a source whose terms require nothing (decision D1)', async () => {
        await seed('hacker_news', 'forums', { url: 'https://news.ycombinator.com/item?id=1' });
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.attribution).toBeNull();
        expect(row.credit).toEqual(expect.objectContaining({ text: 'Hacker News', required: false }));
        expect(row.source_url).toBe('https://news.ycombinator.com/item?id=1');
    });

    it('a hostile stored permalink is served as null; the credit stays', async () => {
        await seed('npr', 'news', { url: 'javascript:alert(document.cookie)' });
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.source_url).toBeNull();
        expect(row.credit.text).toBe('NPR');
    });

    it('a post with no payload at all (text removed, URL dropped) keeps the credit, has no link', async () => {
        const id = await seed('npr', 'news', null);
        await dbRun(
            `UPDATE raw_posts SET text_removed_at = NOW(), text_removed_reason = 'detail window' WHERE id = $1`, [id]);
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.source_url).toBeNull();
        expect(row.published_at).toBeNull();
        expect(row.credit.text).toBe('NPR');
    });

    it('a Reddit post whose text was removed keeps its slug-less permalink as the link', async () => {
        const id = await seed('reddit', 'forums', { url: 'https://www.reddit.com/comments/abc123' });
        await dbRun(
            `UPDATE raw_posts SET text_removed_at = NOW(), text_removed_reason = 'reddit 48 h window' WHERE id = $1`, [id]);
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.source_url).toBe('https://www.reddit.com/comments/abc123');
        expect(row.credit.text).toBe('Reddit');
    });

    it('a permalink on another site is served as null (a feed item cannot make "via NPR" link elsewhere)', async () => {
        await seed('npr', 'news', { url: 'https://evil.example/login?next=https://www.npr.org/' });
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.source_url).toBeNull();
        expect(row.credit.text).toBe('NPR');
    });

    it('tracking and credential query keys never reach the served link', async () => {
        await seed('npr', 'news', { url: 'https://www.npr.org/story?utm_source=feed&id=9&token=SECRET' });
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.source_url).toBe('https://www.npr.org/story?id=9');
        expect(JSON.stringify(row)).not.toMatch(/SECRET|utm_source/);
    });

    it('a legacy row holding an identity link serves no link (D2 re-checked at read time)', async () => {
        await seed('github', 'developer', { url: 'https://github.com/someuser' });
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.source_url).toBeNull();
        expect(row.credit.text).toBe('GitHub');
    });

    // Design D4: attribution deliberately does not read the kill switches (env
    // SOURCE_<SLUG>_ENABLED, the database switch): a stored excerpt of a switched-off
    // source is still credited. Marking the source inactive stands in for them here.
    it('a source marked inactive (data_sources.active = FALSE) keeps its credit and link (D4)', async () => {
        await seed('bbc_news', 'news', { url: 'https://www.bbc.co.uk/news/articles/abc' });
        await dbRun(`UPDATE data_sources SET active = FALSE WHERE name = 'bbc_news'`);
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.credit.text).toBe('BBC News');
        expect(row.source_url).toBe('https://www.bbc.co.uk/news/articles/abc');
    });

    it('a demo-feed post has no credit, no link and no attribution', async () => {
        const src = await insertDemoSource();
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();
        await insertPostWithFullPipeline(src, jobId, mvIds, {
            externalId: 'k1-demo', rawPayload: { url: 'https://www.npr.org/not-real' },
        });
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.data_origin).toBe('demo');
        expect(row.credit).toBeNull();
        expect(row.source_url).toBeNull();
        expect(row.attribution).toBeNull();
        expect(row.published_at).toBeNull();
    });

    it('a slug with no registry entry (retired legacy row) has no credit and no attribution', async () => {
        await seed('wired_ai', 'news', null);
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.credit).toBeNull();
        expect(row.attribution).toBeNull();
        expect(row.source_name).toBe('wired_ai');
        expect(row.data_origin).toBe('live');
    });

    it('the Wikipedia credit carries the licence link and the modified note', async () => {
        await seed('wikipedia', 'nonprofit', { url: 'https://en.wikipedia.org/wiki/Talk:Artificial_intelligence' });
        const row = (await request(app).post('/api/query').send({})).body.results[0];
        expect(row.credit).toEqual(expect.objectContaining({
            text: 'Wikipedia', license: 'CC BY-SA 4.0',
            license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', modified: true,
        }));
    });

    it('the raw_payload is never served wholesale', async () => {
        await seed('npr', 'news', { url: 'https://www.npr.org/x', route: 'technology-rss', license: null, secret: 'do-not-serve' });
        const body = JSON.stringify((await request(app).post('/api/query').send({})).body);
        expect(body).not.toMatch(/do-not-serve/);
        expect(body).not.toMatch(/technology-rss/);
    });
});

describe('K1 attribution: GET /api/sentiment/latest', () => {
    it('recent_posts carry the source name, credit and link', async () => {
        await seed('npr', 'news', { url: 'https://www.npr.org/s', published_at: '2026-09-30T10:00:00.000Z' });
        const res = await request(app).get('/api/sentiment/latest');
        const row = res.body.recent_posts[0];
        expect(row).toEqual(expect.objectContaining({
            source_name: 'npr', attribution: 'NPR', source_url: 'https://www.npr.org/s', data_origin: 'live',
        }));
        expect(row.credit.text).toBe('NPR');
        expect(row.source_category).toBe('news');   // existing field unchanged
    });

    it('a demo post has no credit or link', async () => {
        const src = await insertDemoSource();
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();
        await insertPostWithFullPipeline(src, jobId, mvIds, { externalId: 'k1-demo-s' });
        const row = (await request(app).get('/api/sentiment/latest')).body.recent_posts[0];
        expect(row.data_origin).toBe('demo');
        expect(row.credit).toBeNull();
        expect(row.source_url).toBeNull();
    });
});

describe('K1 attribution: GET /api/audit/:id', () => {
    it('post carries the credit, link, date and origin; provenance.permalink is the same link', async () => {
        const id = await seed('pew', 'policy', { url: 'https://www.pewresearch.org/short-reads/x', published_at: '2026-09-29T00:00:00.000Z' });
        const res = await request(app).get(`/api/audit/${id}`);
        expect(res.status).toBe(200);
        expect(res.body.post).toEqual(expect.objectContaining({
            attribution: 'Pew Research Center',
            source_url: 'https://www.pewresearch.org/short-reads/x',
            published_at: '2026-09-29T00:00:00.000Z',
            data_origin: 'live',
        }));
        expect(res.body.post.credit).toEqual(expect.objectContaining({
            text: 'Pew Research Center, Washington, D.C.', cite_date: true,
        }));
        expect(res.body.provenance.permalink).toBe(res.body.post.source_url);
    });

    it('a hostile permalink is null in both places', async () => {
        const id = await seed('npr', 'news', { url: 'https://user:pw@www.npr.org/x' });
        const body = (await request(app).get(`/api/audit/${id}`)).body;
        expect(body.post.source_url).toBeNull();
        expect(body.provenance.permalink).toBeNull();
    });

    it('provenance.permalink is now stricter than ^https?:// (design section 5): off-source, private and credentialed links are null', async () => {
        for (const url of ['https://evil.example/x', 'http://localhost:3000/admin', 'http://10.0.0.5/x', 'https://www.npr.org/a b']) {
            const id = await seed('npr', 'news', { url });
            const body = (await request(app).get(`/api/audit/${id}`)).body;
            expect([url, body.provenance.permalink]).toEqual([url, null]);
        }
    });

    it('published_at is served as ISO UTC or null, never free text', async () => {
        const good = await seed('npr', 'news', { url: 'https://www.npr.org/a', published_at: '2026-09-29T10:00:00Z' });
        const bad = await seed('npr', 'news', { url: 'https://www.npr.org/b', published_at: '<img src=x onerror=1>' });
        expect((await request(app).get(`/api/audit/${good}`)).body.provenance.published_at).toBe('2026-09-29T10:00:00.000Z');
        const b = (await request(app).get(`/api/audit/${bad}`)).body;
        expect(b.provenance.published_at).toBeNull();
        expect(b.post.published_at).toBeNull();
    });

    it('a demo post has no credit or link, and says it is demo', async () => {
        const src = await insertDemoSource();
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();
        await insertIngestMethodology();
        const id = await insertPostWithFullPipeline(src, jobId, mvIds, { externalId: 'k1-demo-a', rawPayload: { url: 'https://www.npr.org/not-real' } });
        const body = (await request(app).get(`/api/audit/${id}`)).body;
        expect(body.post.data_origin).toBe('demo');
        expect(body.post.credit).toBeNull();
        expect(body.post.source_url).toBeNull();
    });

    it('arXiv receipts carry the acknowledgement notice', async () => {
        const id = await seed('arxiv', 'academic', { url: 'https://arxiv.org/abs/2601.00001' });
        const post = (await request(app).get(`/api/audit/${id}`)).body.post;
        expect(post.credit.notice).toBe('Thank you to arXiv for use of its open access interoperability.');
    });
});

describe('K1 attribution: GET /api/credits', () => {
    it('is an empty catalogue with the site notices when nothing is stored', async () => {
        const res = await request(app).get('/api/credits');
        expect(res.status).toBe(200);
        expect(res.body.sources).toEqual([]);
        expect(res.body.notices).toEqual(SITE_NOTICES);
    });

    it('lists each credited source that has stored real posts, once, in registry order', async () => {
        await seed('arxiv', 'academic', { url: 'https://arxiv.org/abs/1' });
        await seed('npr', 'news', { url: 'https://www.npr.org/a' });
        await seed('npr', 'news', { url: 'https://www.npr.org/b' });
        await seed('wired_ai', 'news', null);           // no registry entry: not listed
        const src = await insertDemoSource('demo_blog', 'blog');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();
        await insertPostWithFullPipeline(src, jobId, mvIds, { externalId: 'k1-demo-c' });   // demo: not listed
        const res = await request(app).get('/api/credits');
        expect(res.body.sources.map(s => s.slug)).toEqual(['npr', 'arxiv']);
        const arxiv = res.body.sources.find(s => s.slug === 'arxiv');
        expect(arxiv.credit.notice).toMatch(/arXiv/);
        expect(arxiv.terms_url).toBe('https://info.arxiv.org/help/api/tou.html');
    });

    it('does not list a source with no posts', async () => {
        await insertSource('npr', 'news');
        expect((await request(app).get('/api/credits')).body.sources).toEqual([]);
    });
});
