// tests/unit/pure/migrationFiles.test.js
// Migration file naming: scripts/migrate.js applies src/db/migrations/*.sql
// in file-name order and records each by file name. Two branches that both
// add "012_*" would both apply, in an order decided by the rest of the name,
// and the docs would name two different "migration 012"s. Every number is
// therefore used once, and file names sort strictly increasing. Gaps are
// allowed (PR #22: parallel branches reserve number ranges; migrate.js
// applies in file-name order and records each file by name).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { listMigrationFiles } = require('../../../scripts/migrate');

const DIR = path.join(__dirname, '../../../src/db/migrations');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();

test('every migration file is NNN_snake_case.sql', () => {
    for (const f of files) expect(f).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
});

test('every migration number is used exactly once, and file names sort strictly increasing (gaps allowed)', () => {
    const numbers = files.map(f => parseInt(f.slice(0, 3), 10));
    expect(new Set(numbers).size).toBe(numbers.length);
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
    expect(numbers[0]).toBe(1);
});

test('the source-collection migrations follow embedding@1.0.0 (012)', () => {
    expect(files.slice(11, 15)).toEqual([
        '012_embedding_methodology.sql',
        '013_source_collection.sql',
        '014_methodology_alignment.sql',
        '015_ingest_text_redaction.sql',
    ]);
});

describe('scripts/migrate.js listMigrationFiles (runtime guard)', () => {
    function dirWith(names) {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
        for (const n of names) fs.writeFileSync(path.join(d, n), '-- test\n');
        return d;
    }

    test('returns the real migrations in apply order', () => {
        expect(listMigrationFiles(DIR)).toEqual(files);
    });

    test('refuses a file-sync conflict copy ("012_x 2.sql")', () => {
        const d = dirWith(['001_a.sql', '002_b.sql', '002_b 2.sql']);
        expect(() => listMigrationFiles(d)).toThrow(/not NNN_snake_case\.sql: 002_b 2\.sql/);
    });

    test('refuses a number used twice', () => {
        const d = dirWith(['001_a.sql', '002_b.sql', '002_c.sql']);
        expect(() => listMigrationFiles(d)).toThrow(/migration number 002 used twice/);
    });

    test('accepts a gap in the numbering; still refuses a duplicate', () => {
        expect(listMigrationFiles(dirWith(['001_a.sql', '002_b.sql', '050_c.sql']))).toEqual(['001_a.sql', '002_b.sql', '050_c.sql']);
        expect(() => listMigrationFiles(dirWith(['001_a.sql', '050_c.sql', '050_d.sql']))).toThrow(/migration number 050 used twice/);
    });

    test('ignores non-SQL files', () => {
        const d = dirWith(['001_a.sql', 'README.md']);
        expect(listMigrationFiles(d)).toEqual(['001_a.sql']);
    });
});
