#!/usr/bin/env node
// scripts/source-admin.js
// Operator commands for one registry source, applied through the database so
// they take effect in every process (worker and web) on the next run,
// without recreating containers.
//
//   npm run source:disable -- <slug> --reason "<why>"
//       the database kill switch (F10-10): the source stops before its next
//       run in every process; GET /api/sources reports it 'disabled'.
//   npm run source:enable -- <slug> [--note "<why>"]
//       clear the database kill switch (env kill switches still apply).
//   npm run source:disable -- <slug> --route <route_id> --reason "<why>"
//   npm run source:enable -- <slug> --route <route_id> [--note "<why>"]
//       the per-ROUTE database kill switch (migration 073): only that route
//       stops before its next run in every process — the source's other
//       routes keep collecting; GET /api/sources reports the route
//       'disabled' with its reason. The route id must be a registry route
//       of the source (validated, never trusted from input). source:enable
//       also accepts the id of a switched-off route the registry no longer
//       has (it holds the whole source disabled until it is cleared).
//   npm run source:reset -- <slug> [--note "<why>"]
//       clear the refused state (F10-5): the source is tried again on its
//       next poll; its open 'source_refused' alert is resolved with the note.
//
// Every command needs GATE_APPROVED_BY ("Name YYYY-MM-DD", PR #22 decision
// G5): it is the recorded actor — from the approved config, never a
// self-asserted $USER (security L6). Re-enabling a source or route needs an
// approval dated on or after the takedown it reverses (UTC date): a standing
// approval from before it cannot undo it. The state change and its
// source_gate_events row ('disabled' / 'enabled' / 'refusal_reset', or
// 'route_disabled' / 'route_enabled' naming the one route) are
// written in ONE transaction (security L6, grumpy L16): neither lands
// without the other.
//
// Exit codes: 0 done, 2 usage error / unknown source or route / no named
// approval / approval older than the takedown / database failure.

'use strict';

require('dotenv').config();
const {
    getSource, getRoute, namedApproval, GATE_APPROVAL_ENV, ROUTE_ID_PATTERN,
} = require('../src/config/source-registry');

const USAGE = [
    'usage: npm run source:disable -- <slug> [--route <route_id>] --reason "<why>"',
    '       npm run source:enable -- <slug> [--route <route_id>] [--note "<why>"]',
    '       npm run source:reset -- <slug> [--note "<why>"]',
].join('\n');

// The flags each command takes. A flag another command takes is refused,
// never silently dropped (a --reason on enable would otherwise vanish).
const FLAGS = {
    disable: new Set(['--route', '--reason']),
    enable: new Set(['--route', '--note']),
    reset: new Set(['--note']),
};

// Control and format characters (newlines, ANSI escapes, bidi overrides) in
// a reason or note would be replayed raw into logs and the gate event, or
// spoof the reason where it is shown; they are refused.
const CONTROL = /[\p{Cc}\p{Cf}]/u;

function flag(args, name) {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    return v === undefined || v.startsWith('--') ? null : v;
}

/**
 * @returns {{ command, slug, route, staleRoute, note, reason } | { error }}
 *   staleRoute: true when `route` is not a registry route of the source but
 *   is well formed — source:enable only; main() then requires a switched-off
 *   row for it.
 */
function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    const [command, slug] = args;
    if (!['reset', 'disable', 'enable'].includes(command) || !slug || slug.startsWith('--')) return { error: USAGE };
    const src = getSource(slug);
    if (!src) return { error: `unknown source '${slug}' (not a registry slug)\n${USAGE}` };
    const note = flag(args, '--note');
    const reason = flag(args, '--reason');
    const route = flag(args, '--route');
    if (note === null || reason === null || route === null) return { error: USAGE };
    // Only this command's flags, each once and with its value: a stray word
    // (e.g. a route id given without --route) is a usage error, never
    // silently ignored.
    const seen = new Set();
    for (let i = 2; i < args.length; i += 2) {
        if (!FLAGS[command].has(args[i])) {
            const other = ['--note', '--reason', '--route'].includes(args[i]);
            return { error: `${other ? `source:${command} does not take ${args[i]}` : `unexpected argument '${args[i]}'`}\n${USAGE}` };
        }
        // A repeated flag is ambiguous (which route was meant?): refused,
        // never resolved silently to the first one.
        if (seen.has(args[i])) return { error: `${args[i]} is given more than once\n${USAGE}` };
        seen.add(args[i]);
    }
    for (const [name, v] of [['--note', note], ['--reason', reason]]) {
        if (v !== undefined && CONTROL.test(v)) return { error: `${name} must not contain control characters (newlines, escapes, bidi overrides)\n${USAGE}` };
    }
    let staleRoute = false;
    if (route !== undefined && !getRoute(src, route)) {
        // Security: the route id is validated against the registry — an
        // exact match of one of the source's route ids — never trusted. Only
        // source:enable may name a well-formed id the registry no longer has,
        // to clear a stale switch (main() checks the row exists).
        if (command !== 'enable' || !ROUTE_ID_PATTERN.test(route)) {
            return { error: `unknown route '${route}' of ${slug} (registry routes: ${src.routes.map(r => r.id).join(', ')})\n${USAGE}` };
        }
        staleRoute = true;
    }
    // A takedown is recorded with its reason.
    if (command === 'disable' && !(reason && reason.trim())) return { error: `source:disable needs --reason "<why>"\n${USAGE}` };
    return { command, slug, route: route || null, staleRoute, note: note || null, reason: reason || null };
}

/** A refusal raised inside the transaction: rolls it back, exit 2, its own message. */
class Refused extends Error {}

/** The date part (UTC) of a timestamp. */
const utcDate = t => new Date(t).toISOString().slice(0, 10);

/**
 * Security review F6: a takedown is reversed only by a named approval dated
 * on or after it — a standing GATE_APPROVED_BY from before the takedown
 * cannot undo it — and not dated in the future (re-review: a standing
 * far-future date would otherwise undo every takedown). One day of slack
 * on the future side allows for an operator ahead of UTC.
 */
function assertApprovalCovers(approval, disabledAt, what, command, now = Date.now()) {
    // The future-date limit applies to every enable (Copilot): a far-future
    // approval is refused even when nothing is switched off.
    const latest = utcDate(now + 86400000);
    if (approval.date > latest) {
        throw new Refused(`${command} needs a named approval dated today: ${GATE_APPROVAL_ENV} is dated ${approval.date}, `
            + `in the future (today is ${utcDate(now)} UTC). Nothing was changed.`);
    }
    if (!disabledAt || approval.date >= utcDate(disabledAt)) return;
    throw new Refused(`${command} needs a named approval dated on or after the takedown it reverses: ${what} was disabled on `
        + `${utcDate(disabledAt)} (UTC) and ${GATE_APPROVAL_ENV} is dated ${approval.date}. Set ${GATE_APPROVAL_ENV}="Name YYYY-MM-DD" `
        + 'with the date of the approval to re-enable it. Nothing was changed.');
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
    // Security review F9: what a takedown publishes.
    const published = 'Published: the reason and the approver\'s name will be shown on GET /api/sources '
        + '(status_reason and routes[].reason).';
    try {
        const row = await db.dbGet('SELECT id FROM data_sources WHERE name = $1', [parsed.slug]);
        if (!row) { err(`source '${parsed.slug}' has no data_sources row — run npm run seed`); return 2; }
        const recordGateEvent = io.recordGateEvent || require('../src/collectors/governance').recordGateEvent;
        const event = (client, ev, reason, routes = null) => recordGateEvent({
            sourceId: row.id, slug: parsed.slug, event: ev, actor: who, approvedBy: who, reason, routes, client,
        });
        // Re-review F9: said BEFORE the change, so the operator can still stop.
        if (parsed.command === 'disable') out(published);
        if (parsed.route && parsed.command === 'disable') {
            // Migration 073: the route switch and its 'route_disabled' event
            // (naming the route) in ONE transaction (L6 / L16).
            await db.dbTransaction(async (client) => {
                await state.setRouteKillSwitch(row.id, parsed.route, true, { reason: parsed.reason, by: who, client });
                await event(client, 'route_disabled', parsed.reason, [parsed.route]);
            });
            out(`${parsed.slug}/${parsed.route}: disabled (database route kill switch) — applies before the next run in every `
                + 'process; the source\'s other routes keep collecting');
        } else if (parsed.route && parsed.command === 'enable') {
            let changed = false;
            await db.dbTransaction(async (client) => {
                // Copilot: FOR UPDATE locks nothing when the route has no
                // row, so a concurrent disable could commit between this
                // read and the clear below and be undone unchecked. A
                // cleared row is made to exist first, then locked: disable
                // and enable of one route serialize on it.
                await client.query(
                    `INSERT INTO source_route_state (source_id, route_id) VALUES ($1, $2) ON CONFLICT (source_id, route_id) DO NOTHING`,
                    [row.id, parsed.route]);
                const cur = (await client.query(
                    `SELECT collection_disabled_at FROM source_route_state WHERE source_id = $1 AND route_id = $2 FOR UPDATE`,
                    [row.id, parsed.route])).rows[0];
                const disabledAt = cur ? cur.collection_disabled_at : null;
                if (parsed.staleRoute && !disabledAt) {
                    const src = getSource(parsed.slug);
                    throw new Refused(`unknown route '${parsed.route}' of ${parsed.slug} (registry routes: `
                        + `${src.routes.map(r => r.id).join(', ')}; no switched-off route has that id)\n${USAGE}`);
                }
                assertApprovalCovers(approval, disabledAt, `${parsed.slug}/${parsed.route}`, 'source:enable');
                changed = await state.setRouteKillSwitch(row.id, parsed.route, false, { client });
                // Grumpy #8: an enable that changed nothing says so in the
                // record, never "cleared".
                const why = parsed.note || 'database route kill switch cleared';
                await event(client, 'route_enabled', changed ? why : `${why} (it was not set: no change)`, [parsed.route]);
            });
            out(`${parsed.slug}/${parsed.route}: database route kill switch cleared${changed ? '' : ' (it was not set)'} `
                + '(env kill switches, COLLECTORS_DISABLED_ROUTES included, still apply)');
        } else if (parsed.command === 'disable') {
            // P10-14: every enable / disable is recorded with who and when —
            // in the same transaction as the switch (L6 / L16).
            await db.dbTransaction(async (client) => {
                await state.setDbKillSwitch(row.id, true, { reason: parsed.reason, by: who, client });
                await event(client, 'disabled', parsed.reason);
            });
            out(`${parsed.slug}: disabled (database kill switch) — applies before its next run in every process`);
        } else if (parsed.command === 'enable') {
            await db.dbTransaction(async (client) => {
                const cur = (await client.query(
                    'SELECT collection_disabled_at FROM data_sources WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
                assertApprovalCovers(approval, cur && cur.collection_disabled_at, parsed.slug, 'source:enable');
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
        if (e instanceof Refused) { err(e.message); return 2; }
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
