#!/usr/bin/env node
// scripts/terms-snapshot.js — `npm run terms:snapshot [-- --only slug1,slug2] [--json]`
// P10-14: a dated snapshot of each source's terms page, fetched once, politely,
// through the collector HTTP client (User-Agent with the contact URL,
// robots.txt, allowed host, size cap). Walled pages (the blocked 4), Reddit
// before approval, refusals and robots disallows are stored as
// 'unreachable' / 'not_fetched' with the date and reason; nothing is ever
// worked around. Rows go to source_terms_snapshots (migration 035) with the
// normalised terms text and its hash (migration 041, PR #22 P1-13). The
// worker also runs this weekly (maintenance task 'terms').

'use strict';

require('dotenv').config();

const USAGE = 'usage: npm run terms:snapshot [-- --only slug1,slug2] [--json]';

/**
 * PR #22 grumpy #15: `--only --json` used to read "--json" as a slug. A
 * value starting with "--" or an unknown slug is a usage error.
 * @returns {{ slugs: string[]|undefined, json: boolean }}
 */
function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    const json = args.includes('--json');
    const i = args.indexOf('--only');
    if (i < 0) return { slugs: undefined, json };
    const v = args[i + 1];
    const slugs = typeof v === 'string' && !v.startsWith('--') ? v.split(',').map(x => x.trim()).filter(Boolean) : [];
    if (!slugs.length) throw new Error(`--only needs a comma-separated list of source slugs\n${USAGE}`);
    const { getSource } = require('../src/config/source-registry');
    const unknown = slugs.filter(x => !getSource(x));
    if (unknown.length) throw new Error(`unknown source slug(s): ${unknown.join(', ')}\n${USAGE}`);
    return { slugs, json };
}

async function main(argv, { env = process.env, transport, out = l => process.stdout.write(l + '\n'), save = true } = {}) {
    const { HttpClient } = require('../src/collectors/http');
    const { snapshotTerms, saveTermsSnapshots } = require('../src/collectors/governance');
    const { slugs, json } = parseArgs(argv);
    const rows = await snapshotTerms({ http: new HttpClient({ env, transport }), slugs, log: json ? () => {} : out });
    if (save) await saveTermsSnapshots(rows);
    // --json prints the rows without the (long) terms text: it is in the DB.
    if (json) out(JSON.stringify(rows.map(({ terms_text, ...r }) => r), null, 2));
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

module.exports = { main, parseArgs, USAGE };
