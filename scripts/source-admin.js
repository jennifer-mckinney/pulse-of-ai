#!/usr/bin/env node
// scripts/source-admin.js
// Operator commands for one registry source, applied through the database so
// they take effect in every process (worker and web) on the next run,
// without recreating containers.
//
//   npm run source:disable -- <slug> --reason "<why>"
//       the database kill switch (F10-10): the source stops before its next
//       run in every process; GET /api/sources reports it 'disabled'.
//   npm run source:enable -- <slug>
//       clear the database kill switch (env kill switches still apply).
//   npm run source:reset -- <slug> [--note "<why>"]
//       clear the refused state (F10-5): the source is tried again on its
//       next poll; its open 'source_refused' alert is resolved with the note.
//
// Every command needs GATE_APPROVED_BY ("Name YYYY-MM-DD", PR #22 decision
// G5): it is the recorded actor — from the approved config, never a
// self-asserted $USER (security L6). The state change and its
// source_gate_events row ('disabled' / 'enabled' / 'refusal_reset') are
// written in ONE transaction (security L6, grumpy L16): neither lands
// without the other.
//
// Exit codes: 0 done, 2 usage error / unknown source / no named approval /
// database failure.

'use strict';

require('dotenv').config();
const { getSource, namedApproval, GATE_APPROVAL_ENV } = require('../src/config/source-registry');

const USAGE = [
    'usage: npm run source:disable -- <slug> --reason "<why>"',
    '       npm run source:enable -- <slug>',
    '       npm run source:reset -- <slug> [--note "<why>"]',
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
    if (!['reset', 'disable', 'enable'].includes(command) || !slug || slug.startsWith('--')) return { error: USAGE };
    if (!getSource(slug)) return { error: `unknown source '${slug}' (not a registry slug)\n${USAGE}` };
    const note = flag(args, '--note');
    const reason = flag(args, '--reason');
    if (note === null || reason === null) return { error: USAGE };
    // A takedown is recorded with its reason.
    if (command === 'disable' && !reason) return { error: `source:disable needs --reason "<why>"\n${USAGE}` };
    return { command, slug, note: note || null, reason: reason || null };
}

/**
 * CLI entry, injectable for tests.
 * @param {string[]} argv  [command, slug, ...flags]
 * @param {{ db?, state?, out?, err?, env?, recordGateEvent? }} io
 */
async function main(argv, io = {}) {
    const out = io.out || ((l) => process.stdout.write(l + '\n'));
    const err = io.err || ((l) => process.stderr.write(l + '\n'));
    const parsed = parseArgs(argv);
    if (parsed.error) { err(parsed.error); return 2; }
    // G5 / L6: the actor is the named approval, never $USER.
    const approval = namedApproval(io.env || process.env);
    if (!approval.ok) {
        err(`source:${parsed.command} needs a named approval: set ${GATE_APPROVAL_ENV}="Name YYYY-MM-DD" `
            + `(${approval.reason}; PR #22 decision G5). Nothing was changed.`);
        return 2;
    }
    const who = approval.value;
    const db = io.db || require('../src/db/connection');
    const state = io.state || require('../src/collectors/state');
    try {
        const row = await db.dbGet('SELECT id FROM data_sources WHERE name = $1', [parsed.slug]);
        if (!row) { err(`source '${parsed.slug}' has no data_sources row — run npm run seed`); return 2; }
        const recordGateEvent = io.recordGateEvent || require('../src/collectors/governance').recordGateEvent;
        const event = (client, ev, reason) => recordGateEvent({
            sourceId: row.id, slug: parsed.slug, event: ev, actor: who, approvedBy: who, reason, client,
        });
        if (parsed.command === 'disable') {
            // P10-14: every enable / disable is recorded with who and when —
            // in the same transaction as the switch (L6 / L16).
            await db.dbTransaction(async (client) => {
                await state.setDbKillSwitch(row.id, true, { reason: parsed.reason, by: who, client });
                await event(client, 'disabled', parsed.reason);
            });
            out(`${parsed.slug}: disabled (database kill switch) — applies before its next run in every process`);
        } else if (parsed.command === 'enable') {
            await db.dbTransaction(async (client) => {
                await state.setDbKillSwitch(row.id, false, { client });
                await event(client, 'enabled', parsed.note || 'database kill switch cleared');
            });
            out(`${parsed.slug}: database kill switch cleared (env kill switches still apply)`);
        } else if (parsed.command === 'reset') {
            // Security L6: clearing a refusal is recorded too.
            const resolution = `manual reset by ${who}${parsed.note ? `: ${parsed.note}` : ''}`;
            await db.dbTransaction(async (client) => {
                await state.clearRefusal(row.id, resolution, { client });
                await event(client, 'refusal_reset', parsed.note || 'refused state cleared');
            });
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
