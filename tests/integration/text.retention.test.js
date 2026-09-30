// tests/integration/text.retention.test.js
// P10-2 against the real test database:
//   - ingest@1.6.0 stores the text ONCE (no text/title copy in raw_payload)
//     and writes a 'collected' data_retention_log row with the insert;
//   - every source's window is enforced by the same job (Guardian 24 h by
//     analogy with ruling 9, the §19 detail window for the rest), by
//     replacing the text with a notice (content is NOT NULL), dropping the
//     url, keeping scores and audit rows, and logging exactly the ids changed;
//   - monthly compaction no longer tries to NULL a NOT NULL column: it rolls
//     up whole months past the window, removes remaining text with the same
//     mechanism and logs true counts; the cutoff month waits;
//   - demo posts are never blanked (they keep the full purge);
//   - the maintenance job runs every step and isolates a failing one.

'use strict';

const db = require('../../src/db/connection');
const { seedSources } = require('../../scripts/seed');
const { storeRawPost } = require('../../src/pipeline/ingest');
const retention = require('../../src/collectors/retention');
const { compactMonth, getMonthsToCompact } = require('../../scripts/compact');
const { processMaintenanceJob, scheduleMaintenance, maintenanceEveryMs } = require('../../src/workers/maintenance.worker');
const { insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

const HOUR = 3600000;
let ids; let mv; let jobId;

beforeEach(async () => {
    await seedSources();
    ids = Object.fromEntries((await db.dbAll("SELECT id, name FROM data_sources WHERE name IN ('guardian', 'hacker_news', 'npr')")).map(r => [r.name, r.id]));
    mv = await insertMethodologyVersions();
    jobId = await insertJob();
});

async function post(slug, hoursAgo, ext) {
    const id = await insertPostWithFullPipeline(ids[slug], jobId, mv, {
        externalId: ext, collectedAt: new Date(Date.now() - hoursAgo * HOUR), location: '',
    });
    await db.dbRun(`UPDATE raw_posts SET raw_payload = $2::jsonb WHERE id = $1`, [id, JSON.stringify({
        text: 'Secret article body about AI', title: 'Secret headline', url: `https://example.org/${ext}/secret-headline`,
        published_at: '2026-09-01T00:00:00Z', location_basis: null, route: 'r',
    })]);
    return id;
}

const scores = async (id) => ({
    audit: await db.dbAll('SELECT id, output FROM decision_audit_log WHERE raw_post_id = $1 ORDER BY id', [id]),
    s: await db.dbGet('SELECT score, indicator FROM sentiment_results WHERE raw_post_id = $1', [id]),
});

describe('ingest@1.6.0: one copy of the text, and a collected row', () => {
    it('stores text only in content; payload keeps metadata; writes the collected row with the insert', async () => {
        const { postId, isNew } = await storeRawPost({
            id: 'g-1', text: 'Headline\n\nBody about AI', title: 'Headline', url: 'https://www.theguardian.com/x',
            published_at: '2026-09-29T00:00:00Z', location: 'London', location_basis: 'publisher', route: 'ai-tag-rss',
        }, ids.guardian);
        expect(isNew).toBe(true);
        const row = await db.dbGet('SELECT content, raw_payload FROM raw_posts WHERE id = $1', [postId]);
        expect(row.content).toBe('Headline Body about AI');
        expect(row.raw_payload).toEqual(expect.objectContaining({ url: 'https://www.theguardian.com/x', location_basis: 'publisher' }));
        for (const k of ['text', 'title', 'body', 'content', 'selftext']) expect(row.raw_payload).not.toHaveProperty(k);
        const log = await db.dbAll('SELECT raw_post_id, action, reason, legal_basis, performed_by FROM data_retention_log');
        expect(log).toEqual([{
            raw_post_id: postId, action: 'collected', legal_basis: 'GDPR Article 6(1)(f) - Legitimate Interest',
            performed_by: 'src/pipeline/ingest.js', reason: expect.any(String),
        }]);
        expect(JSON.parse(log[0].reason)).toEqual({ source: 'guardian', text_retention_hours: 24, text_retention_basis: 'platform terms' });
        // A duplicate writes nothing.
        await storeRawPost({ id: 'g-1', text: 'Headline', url: 'https://www.theguardian.com/x' }, ids.guardian);
        expect(await db.dbAll('SELECT id FROM data_retention_log')).toHaveLength(1);
    });
});

describe('text retention: every window, one job, true logs', () => {
    it('Guardian at 24 h (ruling 9 by analogy); others at the §19 window; scores and audit rows kept', async () => {
        const g = await post('guardian', 25, 'g-old');
        const gFresh = await post('guardian', 2, 'g-new');
        const hnYoung = await post('hacker_news', 25, 'hn-young');
        const hnOld = await post('hacker_news', 91 * 24, 'hn-old');
        const before = { g: await scores(g), hnOld: await scores(hnOld) };

        const totals = await retention.blankExpired();
        expect(totals).toEqual(expect.objectContaining({ guardian: 1, hacker_news: 1 }));
        expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(2);

        const rg = await db.dbGet('SELECT content, raw_payload, text_removed_reason FROM raw_posts WHERE id = $1', [g]);
        expect(rg.content).toBe('[removed: Guardian terms retention]');
        expect(rg.raw_payload).toEqual(expect.objectContaining({
            text: '[removed: Guardian terms retention]', title: '[removed: Guardian terms retention]', url: null,
            published_at: '2026-09-01T00:00:00Z',
        }));
        expect(JSON.stringify(rg.raw_payload)).not.toMatch(/Secret/);
        expect(rg.text_removed_reason).toBe('24-hour retention window ended');
        const rh = await db.dbGet('SELECT content, raw_payload FROM raw_posts WHERE id = $1', [hnOld]);
        expect(rh.content).toBe(retention.DETAIL_NOTICE);
        expect(JSON.stringify(rh.raw_payload)).not.toMatch(/Secret/);
        expect(await scores(g)).toEqual(before.g);
        expect(await scores(hnOld)).toEqual(before.hnOld);
        for (const id of [gFresh, hnYoung]) {
            expect((await db.dbGet('SELECT content FROM raw_posts WHERE id = $1', [id])).content).toMatch(/^Test post/);
        }

        const log = await db.dbAll('SELECT action, reason, legal_basis FROM data_retention_log ORDER BY action');
        expect(log.map(l => l.action)).toEqual(['blanked_platform_terms', 'text_removed_detail_window']);
        const gl = JSON.parse(log[0].reason);
        expect(gl).toMatchObject({ source: 'guardian', post_ids: [g], rule: '24-hour retention' });
        expect(gl.applied_by_analogy).toMatch(/ruling 9.*by analogy/);
        expect(log[0].legal_basis).toMatch(/Guardian Open Platform terms §5.*by analogy/);
        expect(JSON.parse(log[1].reason)).toMatchObject({ source: 'hacker_news', post_ids: [hnOld] });
        expect(log[1].legal_basis).toMatch(/GDPR Article 5\(1\)\(e\)/);

        // Idempotent: nothing changes, no new log row.
        await retention.blankExpired();
        expect(await db.dbAll('SELECT id FROM data_retention_log')).toHaveLength(2);
    });

    it('the receipt block and demo posts: demo text is never blanked (demo keeps the full purge)', async () => {
        const demo = await db.dbRun(
            `INSERT INTO data_sources (name, display_name, source_type, category) VALUES ('demo_x', 'Demo', 'demo', 'news') RETURNING id`);
        const d = await insertPostWithFullPipeline(demo.id, jobId, mv, { externalId: 'd-1', collectedAt: new Date(Date.now() - 200 * 24 * HOUR) });
        await retention.blankExpired();
        expect((await db.dbGet('SELECT text_removed_at FROM raw_posts WHERE id = $1', [d])).text_removed_at).toBeNull();
        expect(retention.retentionStatus('hacker_news', { textRemovedAt: new Date(), textRemovedReason: '90-day detail window ended' }))
            .toMatchObject({ status: 'text_removed', notice: expect.stringMatching(/detail retention window/) });
        expect(retention.retentionStatus('hacker_news', { collectedAt: new Date() })).toBeNull();
        expect(retention.retentionStatus('guardian', { collectedAt: new Date() })).toMatchObject({ status: 'live' });
    });
});

describe('P1-8: blanking strips every payload text key ingest declares', () => {
    it('a legacy payload with body / content / selftext keeps no text after removal', async () => {
        const { PAYLOAD_TEXT_KEYS } = require('../../src/pipeline/ingest');
        const id = await post('hacker_news', 91 * 24, 'hn-legacy');
        await db.dbRun('UPDATE raw_posts SET raw_payload = $2::jsonb WHERE id = $1', [id, JSON.stringify({
            text: 'Secret a', title: 'Secret b', body: 'Secret c', content: 'Secret d', selftext: 'Secret e',
            url: 'https://example.org/x', published_at: '2026-09-01T00:00:00Z', route: 'r',
        })]);
        await retention.blankExpired();
        const row = await db.dbGet('SELECT raw_payload FROM raw_posts WHERE id = $1', [id]);
        expect(JSON.stringify(row.raw_payload)).not.toMatch(/Secret/);
        for (const k of PAYLOAD_TEXT_KEYS) expect(row.raw_payload[k]).toBe(retention.DETAIL_NOTICE);
        expect(row.raw_payload).toMatchObject({ url: null, published_at: '2026-09-01T00:00:00Z', route: 'r' });
    });
});

describe('monthly compaction (spec §19) with the NOT NULL content column', () => {
    it('compacts only months that ended before the cutoff; removes remaining text; logs true counts', async () => {
        const monthStart = new Date(Date.UTC(new Date().getUTCFullYear() - 1, 0, 1));   // January last year
        const inMonth = new Date(monthStart.getTime() + 10 * 24 * HOUR);
        const a = await insertPostWithFullPipeline(ids.npr, jobId, mv, { externalId: 'c-1', collectedAt: inMonth });
        const b = await insertPostWithFullPipeline(ids.npr, jobId, mv, { externalId: 'c-2', collectedAt: inMonth });
        const recent = await insertPostWithFullPipeline(ids.npr, jobId, mv, { externalId: 'c-3', collectedAt: new Date() });

        const months = await getMonthsToCompact();
        const key = monthStart.toISOString().slice(0, 10);
        expect(months).toContain(key);
        expect(months).not.toContain(new Date().toISOString().slice(0, 8) + '01');

        const r = await db.dbTransaction(c => compactMonth(c, key, { log: () => {} }));
        expect(r).toMatchObject({ postsCompacted: 2, contentNulled: 2 });
        for (const id of [a, b]) {
            const row = await db.dbGet('SELECT content, text_removed_at FROM raw_posts WHERE id = $1', [id]);
            expect(row.content).toBe(retention.DETAIL_NOTICE);
            expect(row.text_removed_at).not.toBeNull();
        }
        expect((await db.dbGet('SELECT text_removed_at FROM raw_posts WHERE id = $1', [recent])).text_removed_at).toBeNull();
        expect(await db.dbGet('SELECT post_count FROM monthly_source_rollups WHERE rollup_month = $1', [key])).toEqual({ post_count: 2 });
        expect(await db.dbGet('SELECT posts_compacted, content_nulled FROM compaction_log WHERE compacted_month = $1', [key]))
            .toEqual({ posts_compacted: 2, content_nulled: 2 });
        const logs = await db.dbAll('SELECT action, reason FROM data_retention_log ORDER BY action');
        expect(logs.map(l => l.action)).toEqual(['compacted', 'text_removed_detail_window']);
        expect(JSON.parse(logs[0].reason)).toMatchObject({ month: key, posts_in_month: 2, texts_removed_now: 2 });
        expect(JSON.parse(logs[1].reason).post_ids.sort()).toEqual([a, b].sort());
        expect(await getMonthsToCompact()).not.toContain(key);
    });
});

describe('the repeatable maintenance job', () => {
    it('runs every step in order, isolates a failing one (scrubbed error), then FAILS the job (P0-1)', async () => {
        const order = [];
        const err = await processMaintenanceJob({}, { steps: [
            ['a', async () => { order.push('a'); return 1; }],
            ['b', async () => { order.push('b'); throw new Error('boom'); }],
            ['c', async () => { order.push('c'); return 3; }],
        ] }).catch(e => e);
        expect(order).toEqual(['a', 'b', 'c']);
        expect(err.name).toBe('MaintenanceStepsFailed');
        expect(err.steps).toEqual({ a: { ok: true, result: 1 }, b: { ok: false, error: 'boom' }, c: { ok: true, result: 3 } });
    });

    // PR #22 principal #7: retention every 5 minutes; compaction and the
    // run-table rollup once a day.
    it('registers two BullMQ job schedulers: retention (5 min) and daily (24 h)', async () => {
        const calls = [];
        await scheduleMaintenance({ upsertJobScheduler: async (...a) => calls.push(a) }, {});
        expect(calls).toEqual([
            ['retention', { every: 300000 }, { name: 'maintenance', data: { task: 'retention' } }],
            ['daily', { every: 86400000 }, { name: 'maintenance', data: { task: 'daily' } }],
        ]);
        expect(maintenanceEveryMs({ MAINTENANCE_EVERY_MS: '60000' })).toBe(60000);
        expect(maintenanceEveryMs({ MAINTENANCE_EVERY_MS: '5' })).toBe(300000);
        const { dailyEveryMs } = require('../../src/workers/maintenance.worker');
        expect(dailyEveryMs({ MAINTENANCE_DAILY_EVERY_MS: '3600000' })).toBe(3600000);
    });

    it('the 5-minute task never compacts; the daily task does compaction and the run rollup', () => {
        const { defaultSteps, taskOf } = require('../../src/workers/maintenance.worker');
        const names = (task) => defaultSteps({ log: () => {}, task }).map(([n]) => n);
        expect(names('retention')).toEqual(['retention', 'stale_jobs']);
        expect(names('daily')).toEqual(['compaction', 'source_runs']);
        expect(taskOf({ data: {} })).toBe('retention');           // a job from before the split
        expect(taskOf({ data: { task: 'daily' } })).toBe('daily');
    });
});
