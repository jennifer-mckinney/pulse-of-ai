// tests/integration/migration.012_013.test.js
// Migrations 012 (source collection) and 013 (methodology alignment) and the
// registry seed, against a REAL PostgreSQL:
//   - 012 retires every old seed row with a note, keeps its posts, never
//     touches demo feeds or registry rows, and is idempotent;
//   - scripts/seed.js upserts exactly the 51 registry rows, all active;
//   - 013 orders every 1.0.0 row before its 1.1.0 successor even in one
//     transaction, is idempotent, and leaves released rows untouched;
//   - resolveCurrentMethodology() returns the versions the code implements.

'use strict';

const fs = require('fs');
const path = require('path');
const { dbAll, dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const { seedSources, seedMethodology, sourceConfig } = require('../../scripts/seed');
const { SOURCES } = require('../../src/config/source-registry');
const { resolveCurrentMethodology } = require('../../src/pipeline/methodology');

const read = (f) => fs.readFileSync(path.join(__dirname, '../../src/db/migrations', f), 'utf8');
const SQL_012 = read('012_source_collection.sql');
const SQL_013 = read('013_methodology_alignment.sql');

async function insertOld(name, type = 'rss') {
    return dbGet(
        `INSERT INTO data_sources (name, display_name, source_type, category, active)
         VALUES ($1, $1, $2, 'news', TRUE) RETURNING id`,
        [name, type],
    );
}

describe('migration 012_source_collection.sql', () => {
    it('retires old seed rows (history kept), leaves demo feeds and registry rows alone', async () => {
        const old = await insertOld('techcrunch_ai');
        const demo = await insertOld('demo_news', 'demo');
        await seedSources();
        const post = await dbGet(
            `INSERT INTO raw_posts (source_id, external_id, content, content_hash)
             VALUES ($1, 'x1', 'old post', 'h') RETURNING id`, [old.id]);

        await dbTransaction(c => c.query(SQL_012));
        await dbTransaction(c => c.query(SQL_012));   // idempotent

        const oldRow = await dbGet('SELECT active, retired_at, retired_note FROM data_sources WHERE id = $1', [old.id]);
        expect(oldRow.active).toBe(false);
        expect(oldRow.retired_at).toBeInstanceOf(Date);
        expect(oldRow.retired_note).toMatch(/replaced by the 51-source registry/);
        expect(await dbGet('SELECT id FROM raw_posts WHERE id = $1', [post.id])).toEqual({ id: post.id });

        const demoRow = await dbGet('SELECT active, retired_at FROM data_sources WHERE id = $1', [demo.id]);
        expect(demoRow).toEqual({ active: true, retired_at: null });

        const live = await dbAll(`SELECT name FROM data_sources WHERE active AND source_type <> 'demo'`);
        expect(live).toHaveLength(51);
    });

    it('creates the per-source state and run-outcome tables', async () => {
        const cols = await dbAll(
            `SELECT table_name, column_name FROM information_schema.columns
             WHERE table_name IN ('source_runs', 'source_collection_state')`);
        const names = cols.map(c => `${c.table_name}.${c.column_name}`);
        for (const c of ['source_runs.outcome', 'source_runs.gate_status', 'source_runs.items_fetched',
            'source_collection_state.last_success_at', 'source_collection_state.http_cache',
            'source_collection_state.cursor']) {
            expect(names).toContain(c);
        }
    });
});

describe('scripts/seed.js registry upsert', () => {
    it('upserts exactly the 51 registry rows with non-secret config, idempotently', async () => {
        await seedSources();
        await dbRun(`UPDATE data_sources SET display_name = 'stale', active = FALSE WHERE name = 'npr'`);
        await seedSources();
        const rows = await dbAll('SELECT name, display_name, source_type, category, active, config FROM data_sources ORDER BY name');
        expect(rows).toHaveLength(51);
        const npr = rows.find(r => r.name === 'npr');
        expect(npr).toMatchObject({ display_name: 'NPR', source_type: 'rss', category: 'news', active: true });
        expect(npr.config).toEqual(JSON.parse(JSON.stringify(sourceConfig(SOURCES.find(s => s.slug === 'npr')))));
        expect(JSON.stringify(rows)).not.toMatch(/_KEY"\s*:\s*"[^"]/);   // names only, never values
    });
});

describe('migration 013_methodology_alignment.sql', () => {
    const versions = (component) => dbAll(
        `SELECT version FROM methodology_versions WHERE component = $1 ORDER BY effective_from ASC`, [component]);

    it('orders 1.0.0 before 1.1.0 in one transaction; a later seed cannot reorder them', async () => {
        await dbTransaction(c => c.query(SQL_013));
        await seedMethodology();
        expect((await versions('relevance')).map(r => r.version)).toEqual(['1.0.0', '1.1.0']);
        expect((await versions('discourse')).map(r => r.version)).toEqual(['1.0.0-DQI', '1.1.0-DQI']);
    });

    it('is idempotent and never edits a released row', async () => {
        await seedMethodology();   // released rows first, as on an existing database
        const before = await dbAll('SELECT * FROM methodology_versions WHERE version IN ($1, $2)', ['1.0.0', '1.0.0-DQI']);
        await dbTransaction(c => c.query(SQL_013));
        await dbTransaction(c => c.query(SQL_013));
        const after = await dbAll('SELECT * FROM methodology_versions WHERE version IN ($1, $2)', ['1.0.0', '1.0.0-DQI']);
        expect(after).toEqual(before);
    });

    it('resolveCurrentMethodology returns the rows the code implements', async () => {
        await seedMethodology();
        const mv = await resolveCurrentMethodology();
        const row = await dbGet('SELECT component, version FROM methodology_versions WHERE id = $1', [mv.relevanceMvId]);
        expect(row).toEqual({ component: 'relevance', version: '1.1.0' });
        expect(mv.versions).toEqual(expect.objectContaining({ discourse: '1.1.0-DQI', ingest: '1.2.0' }));
    });

    it('resolveCurrentMethodology fails loudly when a version is not registered', async () => {
        await expect(resolveCurrentMethodology()).rejects.toThrow(/methodology not registered/);
    });
});
