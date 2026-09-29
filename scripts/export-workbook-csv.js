#!/usr/bin/env node
// scripts/export-workbook-csv.js
// Regenerates the committed CSV export of the source workbook (the registry
// of record, ADR 0001):
//
//   node scripts/export-workbook-csv.js            write the CSV
//   node scripts/export-workbook-csv.js --check    exit 1 when the committed CSV is stale
//
// Input:  docs/requirements/Top_50_Global_Online_Sources.xlsx (Rev. 4)
// Output: docs/requirements/Top_52_Global_Online_Sources.rev4.csv
// tests/unit/pure/sourceRegistry.test.js asserts the workbook, this CSV and
// src/config/source-registry.js agree row for row.

'use strict';

const fs = require('fs');
const path = require('path');
const { readWorkbookSources, toCsv } = require('../src/config/workbook');

const ROOT = path.join(__dirname, '..');
const XLSX = path.join(ROOT, 'docs/requirements/Top_50_Global_Online_Sources.xlsx');
const CSV = path.join(ROOT, 'docs/requirements/Top_52_Global_Online_Sources.rev4.csv');

function main(argv) {
    const csv = toCsv(readWorkbookSources(XLSX));
    if (argv.includes('--check')) {
        const current = fs.existsSync(CSV) ? fs.readFileSync(CSV, 'utf8') : '';
        if (current !== csv) {
            process.stderr.write(`${path.relative(ROOT, CSV)} is stale — run node scripts/export-workbook-csv.js\n`);
            return 1;
        }
        process.stdout.write(`${path.relative(ROOT, CSV)} matches the workbook\n`);
        return 0;
    }
    fs.writeFileSync(CSV, csv);
    process.stdout.write(`wrote ${path.relative(ROOT, CSV)}\n`);
    return 0;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, XLSX, CSV };
