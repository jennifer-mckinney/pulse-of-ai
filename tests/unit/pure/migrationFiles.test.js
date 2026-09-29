// tests/unit/pure/migrationFiles.test.js
// Migration file naming: scripts/migrate.js applies src/db/migrations/*.sql
// in file-name order and records each by file name. Two branches that both
// add "012_*" would both apply, in an order decided by the rest of the name,
// and the docs would name two different "migration 012"s. Every number is
// therefore used once, and the numbers run 001..N with no gap.

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '../../../src/db/migrations');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();

test('every migration file is NNN_snake_case.sql', () => {
    for (const f of files) expect(f).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
});

test('every migration number is used exactly once, 001..N without gaps', () => {
    const numbers = files.map(f => parseInt(f.slice(0, 3), 10));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
});

test('the source-collection migrations follow embedding@1.0.0 (012)', () => {
    expect(files.slice(11, 15)).toEqual([
        '012_embedding_methodology.sql',
        '013_source_collection.sql',
        '014_methodology_alignment.sql',
        '015_ingest_text_redaction.sql',
    ]);
});
