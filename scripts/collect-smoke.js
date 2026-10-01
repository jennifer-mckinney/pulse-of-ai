#!/usr/bin/env node
// scripts/collect-smoke.js — `npm run collect:smoke`
//
// LIVE check: fetches every ENABLED no-auth / free-RSS route ONCE (a free
// feed gated only by PERMISSION_GATED_FEEDS_ACCEPTED_BY included when set;
// a free route replaced by an open keyed route is not run) and prints
// items fetched / kept and the gate status per source. Nothing is written to
// the database; it READS each source's database governance state (the same
// one read as the supervised run, scripts/collect.js readGovernance). It
// never touches:
//   - the blocked 4 (WeChat, Telegram, ResearchGate, Cato),
//   - any route that needs a key, licence, approval or permission env
//     (paid / walled / researcher routes),
//   - any source switched off by a kill switch — env or database — or in
//     its refusal cooldown, and any route switched off by a route kill
//     switch (migration 073; security review F1),
//   - anything at all when the database state cannot be read (fail closed).
// Every request goes through the collector HTTP client (User-Agent with
// COLLECTOR_CONTACT_URL, robots.txt for publisher sites, per-host spacing,
// timeouts, backoff, no retries on 401/403).
//
//   npm run collect:smoke [-- --only slug1,slug2] [--json]
//
// Exit code: 0 when every attempted source answered (0 kept items is still
// an answer), 1 when any attempted source errored, 2 on a usage error.

'use strict';

require('dotenv').config();

const { SOURCES, sourceStatus, openRoutes } = require('../src/config/source-registry');
const { buildCollectors } = require('../src/collectors');
const { HttpClient } = require('../src/collectors/http');
const { scrub } = require('../src/collectors/redact');

const USAGE = 'usage: npm run collect:smoke [-- --only slug1,slug2] [--json]';

function parseArgs(argv) {
    const opts = { only: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--only') {
            // G10-23: `--only` without a value is a usage error, not a crash.
            const v = argv[++i];
            const slugs = typeof v === 'string' && !v.startsWith('--') ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
            if (!slugs.length) throw new Error(`--only needs a comma-separated list of source slugs\n${USAGE}`);
            opts.only = new Set(slugs);
        }
        else if (argv[i] === '--json') opts.json = true;
        else throw new Error(`unknown argument '${argv[i]}'`);
    }
    return opts;
}

/**
 * Routes the smoke may run for a source: the routes production would run
 * (openRoutes, so a keyed route that `replaces` a free one wins — G10-23),
 * keyless only, never blocked.
 */
// A free feed opened only by the operator's D1 acknowledgement is still a
// free route (no key, licence or approval) and is smoke-tested when set.
const FREE_ROUTE_SETTINGS = new Set(['PERMISSION_GATED_FEEDS_ACCEPTED_BY']);

function smokeRoutes(src, env, { routeKills = [] } = {}) {
    if (src.auth.kind === 'blocked') return [];
    return openRoutes(src, env, { routeKills }).filter(r => (r.requires || []).every(k => FREE_ROUTE_SETTINGS.has(k)));
}

/**
 * @param {object|null} [gov]  the source's database governance state
 *   (scripts/collect.js readGovernance): its kill switch, refusal state and
 *   switched-off routes. Fails closed: null (no data_sources row) skips it.
 */
async function smokeSource(src, env, http, now = () => Date.now(), gov = null) {
    const routeKills = (gov && gov.route_kills) || [];
    const st = sourceStatus(src, env, { routeKills });
    const row = { rank: src.rank, slug: src.slug, category: src.category, status: st.status, routes: [], fetched: 0, kept: 0, error: null };
    if (st.status !== 'collecting') return { ...row, skipped: st.reason };
    // The database kill switch and the refusal cooldown, exactly as the
    // supervised run applies them (a source with no data_sources row cannot
    // be checked, so it is skipped too).
    try {
        require('./collect').assertDbGatesOpen(src.slug, gov, env);
    } catch (err) {
        return { ...row, status: gov && gov.disabled_at ? 'disabled' : row.status, skipped: err.message };
    }
    const routes = smokeRoutes(src, env, { routeKills });
    if (routes.length === 0) {
        const replaced = openRoutes(src, env, { routeKills }).length > 0;
        return { ...row, skipped: replaced ? 'its keyless route is replaced by a keyed route (not smoke-tested)' : 'no keyless route (gated source)' };
    }
    // The same construction as the runner (buildCollectors), over the
    // keyless routes production would run.
    let collectors;
    try {
        collectors = buildCollectors({ ...src, routes }, { env, http, cursor: {}, httpCache: {}, now, routeKills });
    } catch (err) {
        return { ...row, error: err.message, routes: [{ id: '*', error: `${err.name}: ${err.message}`, ms: 0 }] };
    }
    for (const c of collectors) {
        const route = c.route;
        const started = Date.now();
        try {
            const r = await c.collect();
            row.fetched += r.fetched;
            row.kept += r.payloads.length;
            row.routes.push({ id: route.id, fetched: r.fetched, kept: r.payloads.length, dropped: r.dropped,
                warnings: (r.warnings || []).map(w => w.text), ms: Date.now() - started, sample: r.payloads[0] ? r.payloads[0].title || r.payloads[0].text.slice(0, 80) : null });
        } catch (err) {
            row.routes.push({ id: route.id, error: `${err.name}: ${err.message}`, ms: Date.now() - started });
            row.error = row.error ? `${row.error}; ${route.id}: ${err.message}` : `${route.id}: ${err.message}`;
        }
    }
    return row;
}

/**
 * @param {{ governance?: (slug: string) => Promise<object|null> }} [o]  the
 *   database read (default scripts/collect.js readGovernance; injectable for tests)
 */
async function main(argv, env = process.env, rawOut = line => process.stdout.write(line + '\n'), { governance } = {}) {
    // F10-1: every printed line is scrubbed of env secrets and URL credentials.
    const out = line => rawOut(scrub(line, env));
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (err) {
        out(err.message);
        return 2;
    }
    const readGov = governance || require('./collect').readGovernance;
    const selected = SOURCES.filter(src => !opts.only || opts.only.has(src.slug));
    // Security review F1: every kill switch applies, the database ones too.
    // All database state is read BEFORE any request; when it cannot be read,
    // nothing is fetched (fail closed).
    const govs = new Map();
    try {
        for (const src of selected) govs.set(src.slug, await readGov(src.slug));
    } catch (err) {
        out(`collect:smoke: the database kill switches could not be read (${err.message}) — nothing was fetched. `
            + 'Start the database (npm run docker:up) and retry.');
        return 2;
    }
    const http = new HttpClient({ env });
    out(`collect:smoke — live, keyless routes only (UA: ${http.ua})`);
    const rows = [];
    for (const src of selected) {
        const row = await smokeSource(src, env, http, undefined, govs.get(src.slug));
        rows.push(row);
        if (opts.json) continue;
        const head = `${String(src.rank).padStart(2)}. ${src.slug.padEnd(18)} ${src.category.padEnd(9)} ${row.status.padEnd(17)}`;
        if (row.skipped) { out(`${head} SKIPPED — ${row.skipped}`); continue; }
        out(`${head} ${row.error && row.kept === 0 && row.fetched === 0 ? 'ERROR' : 'OK   '} fetched ${String(row.fetched).padStart(3)} kept ${String(row.kept).padStart(3)}`);
        for (const r of row.routes) {
            if (r.error) out(`      ${r.id}: ${r.error}`);
            else {
                const drop = Object.entries(r.dropped).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
                out(`      ${r.id}: ${r.fetched} fetched, ${r.kept} kept${drop ? ` (dropped: ${drop})` : ''}${r.warnings.length ? ` [warn: ${r.warnings.join('; ')}]` : ''}${r.sample ? ` — e.g. "${r.sample.slice(0, 70)}"` : ''}`);
            }
        }
    }
    const attempted = rows.filter(r => !r.skipped);
    const errored = attempted.filter(r => r.error);
    const summary = {
        attempted: attempted.length,
        answered: attempted.length - errored.filter(r => r.fetched === 0).length,
        with_items: attempted.filter(r => r.kept > 0).length,
        errored: errored.length,
        requests: http.requests,
    };
    if (opts.json) out(JSON.stringify({ rows, summary }, null, 2));
    else out(`\nSUMMARY: ${summary.attempted} sources attempted, ${summary.with_items} with AI items kept, `
        + `${summary.errored} with an error, ${summary.requests} HTTP requests; `
        + `${rows.length - attempted.length} skipped (gated, blocked or disabled — never fetched)`);
    return errored.length ? 1 : 0;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    const db = require('../src/db/connection');
    main(process.argv.slice(2)).then(async (code) => { await db.closePool(); process.exit(code); }).catch(async (err) => {
        process.stderr.write(`collect:smoke: FAILED — ${scrub(err.message)}\n`);
        await db.closePool().catch(() => {});
        process.exit(2);
    });
}

module.exports = { main, parseArgs, smokeRoutes, smokeSource, USAGE };
