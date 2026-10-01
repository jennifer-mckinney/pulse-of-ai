// tests/integration/gold.tools.test.js
// Relevance-accuracy Stage 0 (P3 + P5), against the real test DB:
//   scripts/gold-sample.js     stratified draw, dry run vs --write, determinism
//   scripts/gold-label.js      local-only guard, blind interactive session,
//                              hash check, adjudication, LLM-proposal import
//   scripts/gold-agreement.js  Cohen's kappa per labeller pair
//   scripts/relevance-eval.js  read-only harness: per-category deltas, no writes

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { dbAll, dbGet, dbRun } = require('../../src/db/connection');
const { insertJob, insertMethodologyVersions } = require('./helpers');
const goldSample = require('../../scripts/gold-sample');
const goldLabel = require('../../scripts/gold-label');
const goldAgreement = require('../../scripts/gold-agreement');
const relevanceEval = require('../../scripts/relevance-eval');
const store = require('../../src/gold/store');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const LOCAL = { POSTGRES_HOST: 'localhost', NODE_ENV: 'test' };
const quiet = () => {};
let seq = 0;

async function source(name, category, type = 'rss') {
    return (await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category) VALUES ($1, $1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET source_type = EXCLUDED.source_type, category = EXCLUDED.category RETURNING id`,
        [name, type, category],
    )).id;
}

async function post(sourceId, route, content, relevant, ctx, { removed = false } = {}) {
    seq += 1;
    const id = (await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, raw_payload, text_removed_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
        [sourceId, `ext-${seq}`, content, sha(content), JSON.stringify({ route }), removed ? new Date().toISOString() : null],
    )).id;
    if (relevant !== null) {
        const audit = (await dbRun(
            `INSERT INTO decision_audit_log (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output)
             VALUES ($1, $2, $3, 'relevance', 'keyword-relevance-v1', $4, '{}'::jsonb) RETURNING id`,
            [id, ctx.job, ctx.mv.relevanceMvId, sha(content)],
        )).id;
        await dbRun(
            `INSERT INTO relevance_results (raw_post_id, audit_id, score, matched_keywords, is_relevant) VALUES ($1, $2, $3, '{}', $4)`,
            [id, audit, relevant ? 0.1 : 0, relevant],
        );
    }
    return id;
}

const TEXTS = {
    llm: 'OpenAI ships a large language model',
    power: 'A transformer exploded at the substation; 11 kV lines down',
    zh: '人工智能正在改变医疗',
    spam: 'Delta Airlines reservations number: change my flight with AI',
    vacuum: 'robot vacuum on sale',
    agi: 'When will AGI arrive? A survey of researchers',
};

async function seedPopulation() {
    const ctx = { job: await insertJob(), mv: await insertMethodologyVersions() };
    const bbc = await source('bbc_news', 'news');
    const guardian = await source('guardian', 'news');
    const hn = await source('hacker_news', 'forums', 'api');
    const demo = await source('demo_news_gold', 'news', 'demo');
    const ids = {
        llm: await post(bbc, 'technology-rss', TEXTS.llm, true, ctx),
        power: await post(bbc, 'technology-rss', TEXTS.power, true, ctx),
        agi: await post(bbc, 'technology-rss', TEXTS.agi, true, ctx),
        zh: await post(guardian, 'ai-tag-rss', TEXTS.zh, false, ctx),
        spam: await post(hn, 'algolia-search', TEXTS.spam, null, ctx),
        vacuum: await post(hn, 'algolia-search', TEXTS.vacuum, false, ctx),
    };
    await post(bbc, 'technology-rss', '', true, ctx, { removed: true });          // text removed: not in the population
    await post(demo, 'demo', 'Demo post about AI', true, ctx);                    // demo: never sampled
    return { ctx, ids };
}

function fakeIo(answers) {
    const lines = [];
    return { lines, io: { print: (l) => lines.push(String(l)), ask: async () => (answers.length ? answers.shift() : null) } };
}

describe('scripts/gold-sample.js', () => {
    beforeEach(seedPopulation);

    it('dry run: prints the allocation by stratum and writes nothing', async () => {
        const out = [];
        const r = await goldSample.main(['--total', '4', '--seed', 'seed-a', '--min-per-stratum', '1'], { out: l => out.push(l) });
        expect(r).toMatchObject({ written: false, population: 6, sample_size: 4, items_written: 0 });
        expect(r.strata.map(s => s.stratum)).toEqual([
            'forums|filter|not_relevant|latin', 'forums|filter|unscored|latin',
            'news|ai|not_relevant|cjk', 'news|filter|relevant|latin',
        ]);
        expect(r.strata.find(s => s.stratum === 'news|filter|relevant|latin').population).toBe(3);
        expect(out.join('\n')).toMatch(/DRY RUN, nothing written/);
        expect((await dbGet('SELECT COUNT(*)::int AS n FROM relevance_gold_items')).n).toBe(0);
    });

    it('--write records the items with stratum, design weight and hash; never post text', async () => {
        const out = [];
        const r = await goldSample.main(['--total', '5', '--seed', 'seed-a', '--min-per-stratum', '1',
            '--weight', 'script:cjk=3', '--sample-id', 'gold-test-1', '--write'], { out: l => out.push(l) });
        expect(r.items_written).toBe(5);
        const rows = await dbAll('SELECT * FROM relevance_gold_items WHERE sample_id = $1 ORDER BY draw_rank', ['gold-test-1']);
        expect(rows).toHaveLength(5);
        for (const row of rows) {
            const p = await dbGet('SELECT content FROM raw_posts WHERE id = $1', [row.raw_post_id]);
            expect(row.input_hash).toBe(sha(p.content));
            expect(row.stratum).toBe(`${row.category}|${row.scope}|${row.decision}|${row.script}`);
            expect(Number(row.design_weight)).toBeCloseTo(row.stratum_population / row.stratum_sample_size, 9);
            expect(row.sampler_version).toBe('1.0.0');
        }
        expect(Number(rows.find(x => x.script === 'cjk').stratum_weight)).toBe(3);
        const printed = out.join('\n');
        for (const t of Object.values(TEXTS)) expect(printed).not.toContain(t);
    });

    it('is deterministic: the same seed draws the same posts; a used sample id is refused', async () => {
        const args = (id) => ['--total', '3', '--seed', 'seed-b', '--min-per-stratum', '0', '--sample-id', id, '--write', '--json'];
        await goldSample.main(args('gold-det-1'), { out: quiet });
        await goldSample.main(args('gold-det-2'), { out: quiet });
        const ids = async (s) => (await dbAll('SELECT raw_post_id FROM relevance_gold_items WHERE sample_id = $1 ORDER BY draw_rank', [s])).map(r => r.raw_post_id);
        expect(await ids('gold-det-2')).toEqual(await ids('gold-det-1'));
        await expect(goldSample.main(args('gold-det-1'), { out: quiet })).rejects.toThrow(/already exists/);
    });

    it('refuses a total below the per-stratum minimum', async () => {
        await expect(goldSample.main(['--total', '2', '--seed', 's', '--min-per-stratum', '1'], { out: quiet })).rejects.toThrow(/minimum/);
    });
});

describe('scripts/gold-label.js', () => {
    let ids;
    beforeEach(async () => {
        ({ ids } = await seedPopulation());
        await goldSample.main(['--total', '6', '--seed', 'seed-l', '--min-per-stratum', '1', '--sample-id', 'gold-lab', '--write'], { out: quiet });
    });

    it('refuses a non-loopback database host or production', async () => {
        await expect(goldLabel.main(['--sample', 'gold-lab', '--labeller', 'ann'], { env: { POSTGRES_HOST: 'postgres' } }))
            .rejects.toThrow(/local-only/);
        await expect(goldLabel.main(['--sample', 'gold-lab', '--labeller', 'ann'], { env: { POSTGRES_HOST: 'localhost', NODE_ENV: 'production' } }))
            .rejects.toThrow(/production/);
    });

    it('labels blind, records the hash the labeller saw, and handles help / invalid / skip / quit', async () => {
        const { lines, io } = fakeIo(['?', 'nope', 'c', 'n+s # spam', 'k', 'q']);
        const r = await goldLabel.main(['--sample', 'gold-lab', '--labeller', 'ann'], { env: LOCAL, io });
        expect(r).toMatchObject({ labelled: 2, skipped: 1, quit: true });
        const labels = await dbAll(`SELECT l.label, l.flags, l.method, l.note, l.input_hash, i.input_hash AS item_hash
                                    FROM relevance_gold_labels l JOIN relevance_gold_items i ON i.id = l.item_id ORDER BY l.created_at, l.id`);
        expect(labels.map(x => x.label)).toEqual(['AI_CENTRAL', 'NOT_AI']);
        expect(labels[1]).toMatchObject({ flags: ['SPAM'], method: 'human', note: 'spam' });
        for (const x of labels) expect(x.input_hash).toBe(x.item_hash);
        const printed = lines.join('\n');
        expect(printed).toMatch(/AI_CENTRAL/);                    // the help text
        expect(printed).toMatch(/not understood/);
        expect(printed).not.toMatch(/\|(?:filter|ai|unknown)\|/); // no stratum
        expect(printed).not.toMatch(/not_relevant|unscored/);     // no current decision
    });

    it('skips an item whose text was removed or changed since sampling (never labels from memory)', async () => {
        await dbRun(`UPDATE raw_posts SET content = '', text_removed_at = NOW() WHERE id = $1`, [ids.vacuum]);
        await dbRun(`UPDATE raw_posts SET content = 'edited text' WHERE id = $1`, [ids.zh]);
        const answers = Array.from({ length: 10 }, () => 'n');
        const { lines, io } = fakeIo(answers);
        const r = await goldLabel.main(['--sample', 'gold-lab', '--labeller', 'bob'], { env: LOCAL, io });
        expect(r).toMatchObject({ labelled: 4, unavailable: 2 });
        expect(lines.join('\n')).toMatch(/text removed/);
        expect(lines.join('\n')).toMatch(/text changed/);
    });

    it('--limit stops after N labels; a second session continues with the rest', async () => {
        const a = fakeIo(['c', 'c', 'c']);
        expect((await goldLabel.main(['--sample', 'gold-lab', '--labeller', 'cat', '--limit', '2'], { env: LOCAL, io: a.io })).labelled).toBe(2);
        const b = fakeIo(Array.from({ length: 10 }, () => 'i'));
        expect((await goldLabel.main(['--sample', 'gold-lab', '--labeller', 'cat'], { env: LOCAL, io: b.io })).labelled).toBe(4);
    });

    it('adjudication shows the disputed items with every label, and clears them once ruled', async () => {
        await goldLabel.main(['--sample', 'gold-lab', '--labeller', 'ann'], { env: LOCAL, io: fakeIo(Array(6).fill('c')).io });
        await goldLabel.main(['--sample', 'gold-lab', '--labeller', 'bob'], { env: LOCAL, io: fakeIo(['n', 'c', 'c', 'c+l', 'c', 'c']).io });
        const pending = await store.pendingItems({ sampleId: 'gold-lab', labeller: 'jen', method: 'adjudicated' });
        expect(pending).toHaveLength(2);                          // a label and a flag disagreement
        const { lines, io } = fakeIo(['i', 'c']);
        const r = await goldLabel.main(['--sample', 'gold-lab', '--labeller', 'jen', '--method', 'adjudicated'], { env: LOCAL, io });
        expect(r.labelled).toBe(2);
        expect(lines.join('\n')).toMatch(/ann \(human\): AI_CENTRAL/);
        expect(lines.join('\n')).toMatch(/bob \(human\): NOT_AI/);
        expect(await store.pendingItems({ sampleId: 'gold-lab', labeller: 'jen', method: 'adjudicated' })).toEqual([]);
    });

    it('imports llm_proposed labels all-or-nothing, with the model id; a hash mismatch rejects the whole file', async () => {
        const items = await dbAll(`SELECT id, input_hash FROM relevance_gold_items WHERE sample_id = 'gold-lab' ORDER BY draw_rank`);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-import-'));
        const good = path.join(dir, 'good.jsonl');
        fs.writeFileSync(good, items.map(i => JSON.stringify({ item_id: i.id, label: 'AI_INCIDENTAL', flags: [], input_hash: i.input_hash })).join('\n'));
        const out = [];
        const r = await goldLabel.main(['--import', good, '--labeller', 'llm-batch-1', '--model', 'model-x'], { env: LOCAL, out: l => out.push(l) });
        expect(r.imported).toBe(items.length);
        const rows = await dbAll(`SELECT method, model_id FROM relevance_gold_labels WHERE labeller = 'llm-batch-1'`);
        expect(rows).toHaveLength(items.length);
        for (const x of rows) expect(x).toEqual({ method: 'llm_proposed', model_id: 'model-x' });

        const bad = path.join(dir, 'bad.jsonl');
        fs.writeFileSync(bad, [
            JSON.stringify({ item_id: items[0].id, label: 'NOT_AI', input_hash: items[0].input_hash }),
            JSON.stringify({ item_id: items[1].id, label: 'NOT_AI', input_hash: 'f'.repeat(64) }),
        ].join('\n'));
        await expect(goldLabel.main(['--import', bad, '--labeller', 'llm-batch-2', '--model', 'model-x'], { env: LOCAL, out: quiet }))
            .rejects.toThrow(/input_hash does not match/);
        expect((await dbGet(`SELECT COUNT(*)::int AS n FROM relevance_gold_labels WHERE labeller = 'llm-batch-2'`)).n).toBe(0);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('scripts/gold-agreement.js', () => {
    beforeEach(async () => {
        await seedPopulation();
        await goldSample.main(['--total', '6', '--seed', 'seed-k', '--min-per-stratum', '1', '--sample-id', 'gold-k', '--write'], { out: quiet });
        await goldLabel.main(['--sample', 'gold-k', '--labeller', 'ann'], { env: LOCAL, io: fakeIo(['c', 'c', 'i', 'n', 'n', 'n+s']).io });
        await goldLabel.main(['--sample', 'gold-k', '--labeller', 'bob'], { env: LOCAL, io: fakeIo(['c', 'i', 'i', 'n', 'n', 'n']).io });
        await goldLabel.main(['--sample', 'gold-k', '--labeller', 'jen', '--method', 'adjudicated'], { env: LOCAL, io: fakeIo(['c', 'n+s']).io });
    });

    it('reports kappa per pair; adjudicated labels are not part of agreement', async () => {
        const r = await goldAgreement.main(['--sample', 'gold-k', '--json'], { out: quiet });
        expect(r.labellers).toEqual(['ann', 'bob']);
        expect(r.pairs).toHaveLength(1);
        const p = r.pairs[0];
        expect(p.n).toBe(6);
        expect(p.three_class.po).toBeCloseTo(5 / 6, 12);
        expect(p.binary.po).toBe(1);
        expect(p.binary.kappa).toBe(1);
        expect(p.binary.reading).toBe('reliable');
        expect(p.flags.SPAM.po).toBeCloseTo(5 / 6, 12);
    });

    it('prints a readable report and honours --a / --b', async () => {
        const out = [];
        await goldAgreement.main(['--sample', 'gold-k', '--a', 'bob', '--b', 'ann'], { out: l => out.push(l) });
        const text = out.join('\n');
        expect(text).toMatch(/bob vs ann: 6 shared item/);
        expect(text).toMatch(/binary\s+kappa 1\.000/);
        expect(text).toMatch(/confusion/);
    });
});

describe('scripts/relevance-eval.js (read-only harness)', () => {
    beforeEach(seedPopulation);

    it('reports per-category counts of the released scorers vs the tiered library', async () => {
        const r = await relevanceEval.main(['--json'], { out: quiet });
        expect(r.versions).toMatchObject({ relevance: '1.2.0', admission: '1.0.0' });
        const news = r.categories.find(c => c.category === 'news');
        // llm (both), power (current only: "transformer"), agi and zh (tiered only:
        // relevance@1.2.0 has no "AGI" term and no Chinese terms)
        expect(news).toMatchObject({ n: 4, current_relevant: 2, tiered_ai: 3, both: 1, current_only: 1, tiered_only: 2 });
        const forums = r.categories.find(c => c.category === 'forums');
        expect(forums).toMatchObject({ n: 2, spam: 1, tiered_ai: 0 });
        expect(r.total.n).toBe(6);                                // demo and removed-text posts excluded
    });

    it('honours --category and --limit, prints text without post content', async () => {
        const out = [];
        const r = await relevanceEval.main(['--category', 'forums', '--limit', '1'], { out: l => out.push(l) });
        expect(r.total.n).toBe(1);
        const text = out.join('\n');
        expect(text).toMatch(/^forums\s/m);
        for (const t of Object.values(TEXTS)) expect(text).not.toContain(t);
    });

    it('writes nothing: every score/audit table is unchanged, and the transaction refuses writes', async () => {
        const count = async () => (await dbGet(`SELECT
            (SELECT COUNT(*) FROM relevance_results)::int AS rr, (SELECT COUNT(*) FROM decision_audit_log)::int AS dal,
            (SELECT COUNT(*) FROM methodology_versions)::int AS mv, (SELECT COUNT(*) FROM relevance_gold_items)::int AS gi`));
        const before = await count();
        await relevanceEval.main([], { out: quiet });
        expect(await count()).toEqual(before);
        await expect(store.readOnly(c => c.query(`INSERT INTO processing_jobs (triggered_by) VALUES ('x')`)))
            .rejects.toThrow(/read-only transaction/);
    });
});
