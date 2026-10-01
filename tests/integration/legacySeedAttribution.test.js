// tests/integration/legacySeedAttribution.test.js
// scripts/correct-legacy-seed-attribution.js — the forward-only correction
// for the fictional posts that sit under REAL (retired) sources and are
// therefore counted as live data (diagnosis 2026-10-01). It is NOT run
// automatically: it needs Jennifer's OK. These tests pin what it would do:
//   - dry run (default) changes nothing;
//   - --apply needs a named approval (GATE_APPROVED_BY "Name YYYY-MM-DD");
//   - only the exact legacy signature moves: a retired non-demo source, an
//     (external id, location) pair the seed scripts actually generated
//     (seed-demo.js: demo-<city slug>-<0..7> over its 30 cities; seed-e2e.js:
//     dev-seed-<c>-<p> over its 15 cities — Copilot review #44), and every
//     field the real ingest path writes still NULL;
//   - each moved post goes to the demo feed of its own category and gets one
//     data_retention_log row ('source_reattributed') naming the old source;
//   - no audit row is touched or deleted; a re-run finds nothing;
//   - a missing demo target, an id collision or a linked pseudonymous user
//     aborts the whole correction (nothing moved).

'use strict';

const { dbGet, dbAll, dbRun } = require('../../src/db/connection');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const {
    planCorrection, correctLegacySeedAttribution, legacyFixtureIds, ACTION,
} = require('../../scripts/correct-legacy-seed-attribution');

const APPROVED = { GATE_APPROVED_BY: 'Jennifer McKinney 2026-10-01' };
const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');

async function source(name, { type = 'reddit', category = 'social', retired = true } = {}) {
    return (await dbGet(
        `INSERT INTO data_sources (name, display_name, source_type, category, active, retired_at, retired_note)
         VALUES ($1, $1, $2, $3, $4, $5, $6) RETURNING id`,
        [name, type, category, !retired, retired ? new Date('2026-09-30T05:29:08Z') : null,
            retired ? 'Retired 2026-09-29 by migration 013' : null])).id;
}

async function post(sourceId, externalId, extra = {}) {
    const content = `post ${externalId}`;
    const location = extra.location || 'Amsterdam';
    const row = await dbGet(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location, collected_at,
                                ingest_mv_id, raw_payload, provenance_fingerprint)
         VALUES ($1, $2, $3, $4, $5, '2026-09-28T14:00:00Z', $6, $7, $8) RETURNING id`,
        [sourceId, externalId, content, sha(content), location, extra.ingestMvId || null,
            extra.payload ? JSON.stringify(extra.payload) : null, extra.fingerprint || null]);
    const mv = await dbGet(`SELECT id, model_name FROM methodology_versions WHERE component = 'sentiment' ORDER BY effective_from DESC LIMIT 1`);
    await dbRun(
        `INSERT INTO decision_audit_log (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output, confidence)
         VALUES ($1, $2, $3, 'sentiment', $4, $5, '{}'::jsonb, 0.9)`, [row.id, jobId, mv.id, mv.model_name, sha(content)]);
    return row.id;
}

const sourceNameOf = async (postId) => (await dbGet(
    `SELECT ds.name FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id WHERE rp.id = $1`, [postId])).name;
const corrections = () => dbAll(`SELECT * FROM data_retention_log WHERE action = $1 ORDER BY performed_at, id`, [ACTION]);
const auditCount = async () => (await dbGet('SELECT COUNT(*)::int AS n FROM decision_audit_log')).n;

let ids;
let jobId;
beforeEach(async () => {
    await seedSources();
    await seedMethodology();
    jobId = (await dbGet(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('manual', 'completed') RETURNING id`)).id;
    const legacyReddit = await source('reddit_artificial');
    const legacyNews = await source('techcrunch_ai', { type: 'rss', category: 'news' });
    const activeReal = (await dbGet(`SELECT id FROM data_sources WHERE name = 'guardian'`)).id;
    await source('demo_social', { type: 'demo', category: 'social', retired: false });
    await source('demo_news', { type: 'demo', category: 'news', retired: false });
    const ingestMv = (await dbGet(`SELECT id FROM methodology_versions WHERE component = 'ingest' ORDER BY effective_from DESC LIMIT 1`)).id;
    ids = {
        seedDemo: await post(legacyReddit, 'demo-amsterdam-0'),
        seedDemoUnicode: await post(legacyReddit, 'demo-são-paulo-3', { location: 'São Paulo' }),
        devSeed: await post(legacyNews, 'dev-seed-10-2', { location: 'Paris' }),
        // NOT candidates:
        realLegacy: await post(legacyReddit, 't3_abc123'),                                 // a real post id
        ingested: await post(legacyReddit, 'demo-ingested-1', { ingestMvId: ingestMv }),    // went through storeRawPost
        withPayload: await post(legacyReddit, 'demo-payload-1', { payload: { title: 'x' } }),
        activeSource: await post(activeReal, 'dev-seed-0-0'),                               // e2e-style fixture on an ACTIVE source
        badDevSeed: await post(legacyNews, 'dev-seed-x'),                                   // not the fixture id shape
        // Copilot review #44: the seed-demo branch is the EXACT generated set.
        demoOutOfRange: await post(legacyReddit, 'demo-amsterdam-8'),                      // seed-demo wrote 0..7
        demoUnknownCity: await post(legacyReddit, 'demo-atlantis-0', { location: 'Atlantis' }),
        demoWrongCity: await post(legacyReddit, 'demo-london-1', { location: 'Paris' }),   // id and location disagree
        demoOtherShape: await post(legacyReddit, 'demo-amsterdam-0-extra'),
        devSeedOutOfRange: await post(legacyNews, 'dev-seed-0-3', { location: 'San Francisco' }),   // city 0 has 3 posts
        devSeedWrongCity: await post(legacyNews, 'dev-seed-2-0', { location: 'Berlin' }),          // city 2 is London
    };
});

describe('scripts/correct-legacy-seed-attribution.js', () => {
    test('the generated legacy set is exactly 240 seed-demo + 66 dev-seed (id, location) pairs, all distinct', () => {
        const gen = legacyFixtureIds();
        expect(gen.filter(g => g.id.startsWith('demo-'))).toHaveLength(240);
        expect(gen.filter(g => g.id.startsWith('dev-seed-'))).toHaveLength(66);
        expect(new Set(gen.map(g => g.id)).size).toBe(306);
        expect(gen).toContainEqual(expect.objectContaining({ id: 'demo-são-paulo-7', location: 'São Paulo' }));
        // City 14 (Lagos) has 3 + (14 % 4) = 5 posts: 0..4. City 0 has 3: 0..2.
        expect(gen).toContainEqual(expect.objectContaining({ id: 'dev-seed-14-4', location: 'Lagos' }));
        expect(gen.map(g => g.id)).not.toContain('dev-seed-14-5');
        expect(gen.map(g => g.id)).not.toContain('dev-seed-0-3');
    });

    test('the plan selects exactly the legacy signature and maps each post to its category\'s demo feed', async () => {
        const plan = await planCorrection();
        expect(plan.blockers).toEqual([]);
        expect(plan.candidates.map(c => [c.external_id, c.from_name, c.to_name, c.origin]).sort()).toEqual([
            ['demo-amsterdam-0', 'reddit_artificial', 'demo_social', 'scripts/seed-demo.js (removed in c9844b2)'],
            ['demo-são-paulo-3', 'reddit_artificial', 'demo_social', 'scripts/seed-demo.js (removed in c9844b2)'],
            ['dev-seed-10-2', 'techcrunch_ai', 'demo_news', 'scripts/test/seed-e2e.js run against this database'],
        ]);
    });

    // Copilot re-review #44: once moved, these posts are purged as demo data;
    // the purge's recorded legal basis must name this correction as a source
    // of demo-feed posts, not only scripts/populate.js.
    test('the demo purge\'s legal basis names this correction\'s action', () => {
        const { DEMO_PURGE_LEGAL_BASIS } = require('../../scripts/compact');
        expect(DEMO_PURGE_LEGAL_BASIS).toContain(ACTION);
    });

    test('dry run (the default) changes nothing', async () => {
        const before = await auditCount();
        const r = await correctLegacySeedAttribution({ env: {} });
        expect(r).toMatchObject({ applied: false, candidates: 3 });
        expect(await sourceNameOf(ids.seedDemo)).toBe('reddit_artificial');
        expect(await corrections()).toEqual([]);
        expect(await auditCount()).toBe(before);
    });

    test('--apply refuses without a named approval', async () => {
        await expect(correctLegacySeedAttribution({ apply: true, env: {} })).rejects.toThrow(/GATE_APPROVED_BY/);
        await expect(correctLegacySeedAttribution({ apply: true, env: { GATE_APPROVED_BY: 'yes' } })).rejects.toThrow(/GATE_APPROVED_BY/);
        expect(await sourceNameOf(ids.seedDemo)).toBe('reddit_artificial');
        expect(await corrections()).toEqual([]);
    });

    test('--apply moves only the candidates, logs one audit row each, keeps every decision audit row, and is idempotent', async () => {
        const before = await auditCount();
        const r = await correctLegacySeedAttribution({ apply: true, env: APPROVED });
        expect(r).toMatchObject({ applied: true, candidates: 3, moved: 3 });

        expect(await sourceNameOf(ids.seedDemo)).toBe('demo_social');
        expect(await sourceNameOf(ids.seedDemoUnicode)).toBe('demo_social');
        expect(await sourceNameOf(ids.devSeed)).toBe('demo_news');
        for (const k of ['realLegacy', 'ingested', 'withPayload', 'demoOutOfRange', 'demoUnknownCity', 'demoWrongCity', 'demoOtherShape']) {
            expect([k, await sourceNameOf(ids[k])]).toEqual([k, 'reddit_artificial']);
        }
        for (const k of ['badDevSeed', 'devSeedOutOfRange', 'devSeedWrongCity']) {
            expect([k, await sourceNameOf(ids[k])]).toEqual([k, 'techcrunch_ai']);
        }
        expect(await sourceNameOf(ids.activeSource)).toBe('guardian');
        expect(await auditCount()).toBe(before);

        const log = await corrections();
        expect(log).toHaveLength(3);
        const byPost = Object.fromEntries(log.map(l => [l.raw_post_id, l]));
        const entry = byPost[ids.seedDemo];
        expect(entry.performed_by).toBe('scripts/correct-legacy-seed-attribution.js (approved by Jennifer McKinney 2026-10-01)');
        expect(JSON.parse(entry.reason)).toMatchObject({
            correction: 'source attribution of a fictional post',
            external_id: 'demo-amsterdam-0',
            from_source: 'reddit_artificial', to_source: 'demo_social',
            origin: 'scripts/seed-demo.js (removed in c9844b2)',
        });
        expect(entry.legal_basis).toBeNull();

        const again = await correctLegacySeedAttribution({ apply: true, env: APPROVED });
        expect(again).toMatchObject({ applied: true, candidates: 0, moved: 0 });
        expect(await corrections()).toHaveLength(3);
    });

    test('a category without a demo feed aborts the whole correction', async () => {
        const legacyPolicy = await source('nist_ai', { type: 'rss', category: 'policy' });
        await post(legacyPolicy, 'dev-seed-3-1', { location: 'Berlin' });
        const plan = await planCorrection();
        expect(plan.blockers).toEqual([expect.stringMatching(/no demo feed source for category "policy"/)]);
        await expect(correctLegacySeedAttribution({ apply: true, env: APPROVED })).rejects.toThrow(/policy/);
        expect(await sourceNameOf(ids.seedDemo)).toBe('reddit_artificial');
        expect(await corrections()).toEqual([]);
    });

    test('a post linked to a pseudonymous user aborts the whole correction', async () => {
        const user = await dbGet(`INSERT INTO pseudonymous_users (pseudo_id, correlation_confidence) VALUES ('p-legacy', 0.5) RETURNING id`);
        await dbRun('UPDATE raw_posts SET pseudo_user_id = $2 WHERE id = $1', [ids.seedDemo, user.id]);
        const plan = await planCorrection();
        expect(plan.blockers).toEqual([expect.stringMatching(/demo-amsterdam-0.*linked to a pseudonymous user/)]);
        await expect(correctLegacySeedAttribution({ apply: true, env: APPROVED })).rejects.toThrow(/pseudonymous user/);
        expect(await sourceNameOf(ids.devSeed)).toBe('techcrunch_ai');
        expect(await corrections()).toEqual([]);
    });

    test('an external id already used by the target demo feed aborts the whole correction', async () => {
        const demoSocial = (await dbGet(`SELECT id FROM data_sources WHERE name = 'demo_social'`)).id;
        await post(demoSocial, 'demo-amsterdam-0');
        const plan = await planCorrection();
        expect(plan.blockers).toEqual([expect.stringMatching(/demo-amsterdam-0.*already exists under demo_social/)]);
        await expect(correctLegacySeedAttribution({ apply: true, env: APPROVED })).rejects.toThrow(/already exists/);
        expect(await corrections()).toEqual([]);
    });
});
