#!/usr/bin/env node
// scripts/terms-snapshot.js — `npm run terms:snapshot [-- --only slug1,slug2] [--json]`
// P10-14: a dated SHA-256 of each source's terms page, fetched once, politely,
// through the collector HTTP client (User-Agent with the contact URL,
// robots.txt, allowed host, size cap). Walled pages (the blocked 4), Reddit
// before approval, refusals and robots disallows are stored as
// 'unreachable' / 'not_fetched' with the date and reason; nothing is ever
// worked around. Rows go to source_terms_snapshots (migration 035).

'use strict';

require('dotenv').config();

async function main(argv, { env = process.env, transport, out = l => process.stdout.write(l + '\n'), save = true } = {}) {
    const { HttpClient } = require('../src/collectors/http');
    const { snapshotTerms, saveTermsSnapshots } = require('../src/collectors/governance');
    const i = argv.indexOf('--only');
    const slugs = i >= 0 && argv[i + 1] ? argv[i + 1].split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const rows = await snapshotTerms({ http: new HttpClient({ env, transport }), slugs, log: argv.includes('--json') ? () => {} : out });
    if (save) await saveTermsSnapshots(rows);
    if (argv.includes('--json')) out(JSON.stringify(rows, null, 2));
    return rows;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    const db = require('../src/db/connection');
    main(process.argv.slice(2))
        .then(async () => { await db.closePool(); process.exit(0); })
        .catch(async (err) => {
            process.stderr.write(`terms-snapshot: FAILED — ${require('../src/collectors/redact').scrub(err.message)}\n`);
            await db.closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = { main };
