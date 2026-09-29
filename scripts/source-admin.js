#!/usr/bin/env node
// scripts/source-admin.js
// Operator commands for one registry source, applied through the database so
// they take effect in every process (worker and web) on the next run,
// without recreating containers.
//
//   npm run source:reset -- <slug> [--note "<why>"]
//       clear the refused state (F10-5): the source is tried again on its
//       next poll; its open 'source_refused' alert is resolved with the note.
//
// Exit codes: 0 done, 2 usage error / unknown source / database failure.

'use strict';

require('dotenv').config();
const { getSource } = require('../src/config/source-registry');

const USAGE = [
    'usage: npm run source:reset -- <slug> [--note "<why>"]',
].join('\n');

function flag(args, name) {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    return v === undefined || v.startsWith('--') ? null : v;
}

/** @returns {{ command, slug, note } | { error }} */
function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    const [command, slug] = args;
    if (!['reset'].includes(command) || !slug || slug.startsWith('--')) return { error: USAGE };
    if (!getSource(slug)) return { error: `unknown source '${slug}' (not a registry slug)\n${USAGE}` };
    const note = flag(args, '--note');
    if (note === null) return { error: USAGE };
    return { command, slug, note: note || null };
}

/**
 * CLI entry, injectable for tests.
 * @param {string[]} argv  [command, slug, ...flags]
 * @param {{ db?, state?, out?, err?, who? }} io
 */
async function main(argv, io = {}) {
    const out = io.out || ((l) => process.stdout.write(l + '\n'));
    const err = io.err || ((l) => process.stderr.write(l + '\n'));
    const parsed = parseArgs(argv);
    if (parsed.error) { err(parsed.error); return 2; }
    const db = io.db || require('../src/db/connection');
    const state = io.state || require('../src/collectors/state');
    const who = io.who || process.env.USER || 'operator';
    try {
        const row = await db.dbGet('SELECT id FROM data_sources WHERE name = $1', [parsed.slug]);
        if (!row) { err(`source '${parsed.slug}' has no data_sources row — run npm run seed`); return 2; }
        if (parsed.command === 'reset') {
            await state.clearRefusal(row.id, `manual reset by ${who}${parsed.note ? `: ${parsed.note}` : ''}`);
            out(`${parsed.slug}: refused state cleared — it is tried again on its next poll`);
        }
        return 0;
    } catch (e) {
        err(`source-admin: database error — ${e.message}`);
        return 2;
    }
}

/* istanbul ignore next -- process entry point; main() is tested directly */
if (require.main === module) {
    const db = require('../src/db/connection');
    main(process.argv.slice(2), { db }).then(async (code) => { await db.closePool(); process.exit(code); });
}

module.exports = { parseArgs, main, USAGE };
