// tests/integration/migration.065.test.js
// Dependabot #29: migration 065 registers embedding@1.1.0
// (sentence-transformers 6.1.0, same model and revision) against a REAL
// PostgreSQL — field for field as the registry defines it, idempotently,
// without touching the released embedding@1.0.0 row or any stored vector.

'use strict';

const fs = require('fs');
const path = require('path');
const { dbAll, dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const { METHODOLOGY_VERSIONS } = require('../../src/config/methodology-registry');

const read = f => fs.readFileSync(path.join(__dirname, '../../src/db/migrations', f), 'utf8');
const SQL_012 = read('012_embedding_methodology.sql');
const SQL_065 = read('065_embedding_sentence_transformers_6.sql');
const reg = v => METHODOLOGY_VERSIONS.find(m => m.component === 'embedding' && m.version === v);
const row = v => dbGet(
    `SELECT * FROM methodology_versions WHERE component = 'embedding' AND version = $1`, [v]);

describe('migration 065_embedding_sentence_transformers_6.sql', () => {
    it('registers embedding@1.1.0 as in the registry, after 1.0.0, idempotently, leaving 1.0.0 unedited', async () => {
        await dbTransaction(c => c.query(SQL_012));
        const v100 = await row('1.0.0');
        await dbTransaction(c => c.query(SQL_065));
        await dbTransaction(c => c.query(SQL_065));

        expect(await row('1.0.0')).toEqual(v100);
        const v110 = await row('1.1.0');
        const r = reg('1.1.0');
        expect(v110).toMatchObject({ model_name: r.model_name, config: r.config, justification: r.justification });
        expect(v110.config.library).toBe('sentence-transformers==6.1.0');
        expect(v110.config.revision).toBe(v100.config.revision);
        // "latest effective_from wins" agrees with the code's CURRENT version.
        expect(new Date(v110.effective_from).getTime()).toBeGreaterThan(new Date(v100.effective_from).getTime());
        const rows = await dbAll(
            `SELECT version FROM methodology_versions WHERE component = 'embedding' ORDER BY effective_from`);
        expect(rows.map(x => x.version)).toEqual(['1.0.0', '1.1.0']);
    });

    it('leaves vectors already stamped embedding@1.0.0 as they are', async () => {
        const src = await dbRun(
            `INSERT INTO data_sources (name, display_name, source_type, category)
             VALUES ('m065-src', 'Migration 065 test', 'reddit', 'social') RETURNING id`);
        const post = await dbRun(
            `INSERT INTO raw_posts (source_id, external_id, content, content_hash)
             VALUES ($1, 'm065-1', 'machine learning text', encode(sha256('m065-1'::bytea), 'hex')) RETURNING id`, [src.id]);
        const vec = `[${new Array(384).fill(0.01).join(',')}]`;
        await dbRun(
            `INSERT INTO post_embeddings (raw_post_id, embedding, model_name, methodology_version)
             VALUES ($1, $2::vector, 'sentence-transformers/all-MiniLM-L6-v2', '1.0.0')`, [post.id, vec]);

        await dbTransaction(c => c.query(SQL_065));

        const e = await dbGet('SELECT methodology_version FROM post_embeddings WHERE raw_post_id = $1', [post.id]);
        expect(e.methodology_version).toBe('1.0.0');
    });
});
