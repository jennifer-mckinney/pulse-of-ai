#!/usr/bin/env node
// scripts/generate-methodology-migration.js
// Prints the INSERT statements of a methodology migration from
// src/config/methodology-registry.js, in the shape migrations 011/014/015 use
// (config/justification dollar-quoted so they stay byte-identical to the
// registry; effective_from = clock_timestamp() so rows inserted in one
// migration transaction keep their order).
//
//   node scripts/generate-methodology-migration.js relevance@1.1.0 discourse@1.1.0-DQI
//
// tests/unit/pure/methodologyRegistry.test.js parses the migrations back and
// fails on any drift from the registry.

'use strict';

const { METHODOLOGY_VERSIONS } = require('../src/config/methodology-registry');

function insertSql(m) {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    return [
        `-- ${m.component}@${m.version}`,
        'INSERT INTO methodology_versions (component, version, model_name, config, justification, effective_from)',
        'VALUES (',
        `    ${q(m.component)},`,
        `    ${q(m.version)},`,
        `    ${q(m.model_name)},`,
        `    $cfg$${JSON.stringify(m.config, null, 4)}$cfg$::jsonb,`,
        `    $just$${m.justification}$just$,`,
        '    clock_timestamp()',
        ')',
        'ON CONFLICT (component, version) DO NOTHING;',
    ].join('\n');
}

function generate(keys) {
    return keys.map((key) => {
        const m = METHODOLOGY_VERSIONS.find(r => `${r.component}@${r.version}` === key);
        if (!m) throw new Error(`no registry row ${key}`);
        return insertSql(m);
    }).join('\n\n') + '\n';
}

/* istanbul ignore next -- process entry point */
if (require.main === module) process.stdout.write(generate(process.argv.slice(2)));

module.exports = { generate, insertSql };
