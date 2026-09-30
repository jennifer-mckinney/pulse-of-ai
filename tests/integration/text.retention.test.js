// tests/integration/text.retention.test.js
// P10-2 against the real test database:
//   - ingest@1.6.0 stores the text ONCE (no text/title copy in raw_payload)
//     and writes a 'collected' data_retention_log row with the insert;
//   - every source's window is enforced by the same job (YouTube 30 days by
//     analogy with ruling 9, the §19 detail window for the rest — the
//     Guardian included since Jennifer's ruling "Use normal retention"), by
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
    ids = Object.fromEntries((await db.dbAll("SELECT id, name FROM data_sources WHERE name IN ('guardian', 'hacker_news', 'npr', 'youtube')")).map(r => [r.name, r.id]));
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
        // GUARDIAN ruling (2026-09-29, "Use normal retention"): the §19 detail window.
        expect(JSON.parse(log[0].reason)).toEqual({ source: 'guardian', text_retention_hours: 90 * 24, text_retention_basis: 'detail window (spec §19)' });
        // A duplicate writes nothing.
        await storeRawPost({ id: 'g-1', text: 'Headline', url: 'https://www.theguardian.com/x' }, ids.guardian);
        expect(await db.dbAll('SELECT id FROM data_retention_log')).toHaveLength(1);
    });
});

describe('text retention: every window, one job, true logs', () => {
    it('YouTube at 30 days (ruling 9 by analogy); the Guardian and the rest at the §19 window; scores and audit rows kept', async () => {
        const y = await post('youtube', 31 * 24, 'y-old');
        const yFresh = await post('youtube', 2, 'y-new');
        // GUARDIAN ruling (Jennifer, 2026-09-29), verbatim "Use normal retention":
        // no 24 h blanking any more — only the §19 detail window.
        const gDay = await post('guardian', 25, 'g-day');
        const gOld = await post('guardian', 91 * 24, 'g-old');
        const hnYoung = await post('hacker_news', 25, 'hn-young');
        const hnOld = await post('hacker_news', 91 * 24, 'hn-old');
        const before = { y: await scores(y), hnOld: await scores(hnOld), gOld: await scores(gOld) };

        const totals = await retention.blankExpired();
        expect(totals).toEqual(expect.objectContaining({ youtube: 1, guardian: 1, hacker_news: 1 }));
        expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(3);

        const ry = await db.dbGet('SELECT content, raw_payload, text_removed_reason FROM raw_posts WHERE id = $1', [y]);
        const yNotice = retention.removalNoticeFor('youtube');
        expect(ry.content).toBe(yNotice);
        expect(ry.raw_payload).toEqual(expect.objectContaining({ text: yNotice, title: yNotice, url: null, published_at: '2026-09-01T00:00:00Z' }));
        expect(JSON.stringify(ry.raw_payload)).not.toMatch(/Secret/);
        expect(ry.text_removed_reason).toBe('720-hour retention window ended');
        for (const id of [hnOld, gOld]) {
            const r = await db.dbGet('SELECT content, raw_payload, text_removed_reason FROM raw_posts WHERE id = $1', [id]);
            expect(r.content).toBe(retention.DETAIL_NOTICE);
            expect(r.text_removed_reason).toBe('90-day detail window ended');
            expect(JSON.stringify(r.raw_payload)).not.toMatch(/Secret/);
        }
        expect(await scores(y)).toEqual(before.y);
        expect(await scores(hnOld)).toEqual(before.hnOld);
        expect(await scores(gOld)).toEqual(before.gOld);
        for (const id of [yFresh, gDay, hnYoung]) {
            expect((await db.dbGet('SELECT content, text_removed_at FROM raw_posts WHERE id = $1', [id])))
                .toEqual({ content: expect.stringMatching(/^Test post/), text_removed_at: null });
        }

        const log = await db.dbAll('SELECT action, reason, legal_basis FROM data_retention_log ORDER BY action, reason');
        expect(log.map(l => l.action)).toEqual(['blanked_platform_terms', 'text_removed_detail_window', 'text_removed_detail_window']);
        const yl = JSON.parse(log[0].reason);
        expect(yl).toMatchObject({ source: 'youtube', post_ids: [y], rule: '720-hour retention' });
        expect(yl.applied_by_analogy).toMatch(/ruling 9.*by analogy/);
        expect(log.slice(1).map(l => JSON.parse(l.reason)).map(r => [r.source, r.post_ids]).sort())
            .toEqual([['guardian', [gOld]], ['hacker_news', [hnOld]]]);
        for (const l of log.slice(1)) expect(l.legal_basis).toMatch(/GDPR Article 5\(1\)\(e\)/);

        // Idempotent: nothing changes, no new log row.
        await retention.blankExpired();
        expect(await db.dbAll('SELECT id FROM data_retention_log')).toHaveLength(3);
    });

    it('GUARDIAN ruling: recorded verbatim in the registry; no platform window; old 24 h blanks keep a truthful receipt', async () => {
        const { getSource, retentionHours } = require('../../src/config/source-registry');
        const g = getSource('guardian');
        expect(g.retention).toBeUndefined();
        expect(g.retentionRuling).toMatchObject({ by: 'Jennifer McKinney', date: '2026-09-29', verbatim: 'Use normal retention' });
        expect(JSON.stringify(g)).not.toMatch(/awaiting (Jennifer's )?confirmation/i);
        expect(retentionHours(g, {})).toBe(90 * 24);
        expect(retention.removalNoticeFor('guardian')).toBe(retention.DETAIL_NOTICE);
        // A live Guardian post has no platform countdown any more.
        expect(retention.retentionStatus('guardian', { collectedAt: new Date() })).toBeNull();
        // A post blanked at 24 h BEFORE the ruling says so, not "detail window".
        const old = retention.retentionStatus('guardian', { textRemovedAt: new Date(), textRemovedReason: '24-hour retention window ended' });
        expect(old).toMatchObject({ status: 'text_removed', reason: '24-hour retention window ended' });
        expect(old.notice).toMatch(/after 24 hours under the window then in force.*withdrawn by Jennifer McKinney's ruling of 2026-09-29, "Use normal retention"/);
        // A post removed at the §19 window reads as such.
        expect(retention.retentionStatus('guardian', { textRemovedAt: new Date(), textRemovedReason: '90-day detail window ended' }).notice)
            .toMatch(/^Text removed at the end of the detail retention window/);
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
        expect(retention.retentionStatus('youtube', { collectedAt: new Date() })).toMatchObject({ status: 'live' });
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
    it('registers three BullMQ job schedulers: retention (5 min), daily (24 h), terms (7 days)', async () => {
        const calls = [];
        await scheduleMaintenance({ upsertJobScheduler: async (...a) => calls.push(a) }, {});
        expect(calls).toEqual([
            ['retention', { every: 300000 }, { name: 'maintenance', data: { task: 'retention' } }],
            ['daily', { every: 86400000 }, { name: 'maintenance', data: { task: 'daily' } }],
            ['terms', { every: 604800000 }, { name: 'maintenance', data: { task: 'terms' } }],
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
        expect(names('terms')).toEqual(['terms_snapshot']);
        expect(taskOf({ data: {} })).toBe('retention');           // a job from before the split
        expect(taskOf({ data: { task: 'daily' } })).toBe('daily');
    });
});
