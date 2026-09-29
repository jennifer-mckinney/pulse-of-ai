#!/usr/bin/env node
// scripts/collect-smoke.js — `npm run collect:smoke`
//
// LIVE check: fetches every ENABLED no-auth / free-RSS route ONCE and prints
// items fetched / kept and the gate status per source. Nothing is written to
// the database. It never touches:
//   - the blocked 4 (WeChat, Telegram, ResearchGate, Cato),
//   - any route that needs a key, licence, approval or permission env
//     (paid / walled / researcher routes),
//   - any source switched off by a kill switch.
// Every request goes through the collector HTTP client (User-Agent with
// COLLECTOR_CONTACT_URL, robots.txt for publisher sites, per-host spacing,
// timeouts, backoff, no retries on 401/403).
//
//   npm run collect:smoke [-- --only slug1,slug2] [--json]
//
// Exit code: 0 when every attempted source answered (0 kept items is still
// an answer), 1 when any attempted source errored.

'use strict';

require('dotenv').config();

const { SOURCES, sourceStatus } = require('../src/config/source-registry');
const { ADAPTERS } = require('../src/collectors');
const { HttpClient } = require('../src/collectors/http');

function parseArgs(argv) {
    const opts = { only: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--only') opts.only = new Set(argv[++i].split(',').map(s => s.trim()));
        else if (argv[i] === '--json') opts.json = true;
        else throw new Error(`unknown argument '${argv[i]}'`);
    }
    return opts;
}

/** Routes the smoke may run for a source: open, keyless, never blocked. */
function smokeRoutes(src, env) {
    if (src.auth.kind === 'blocked') return [];
    return src.routes.filter(r => (r.requires || []).length === 0);
}

async function smokeSource(src, env, http, now = () => Date.now()) {
    const st = sourceStatus(src, env);
    const row = { rank: src.rank, slug: src.slug, category: src.category, status: st.status, routes: [], fetched: 0, kept: 0, error: null };
    if (st.status !== 'collecting') return { ...row, skipped: st.reason };
    const routes = smokeRoutes(src, env);
    if (routes.length === 0) return { ...row, skipped: 'no keyless route (gated source)' };
    for (const route of routes) {
        const Cls = ADAPTERS[route.adapter];
        const started = Date.now();
        try {
            const c = new Cls({ source: src, route, env, http, cursor: {}, httpCache: {}, now });
            const r = await c.collect();
            row.fetched += r.fetched;
            row.kept += r.payloads.length;
            row.routes.push({ id: route.id, fetched: r.fetched, kept: r.payloads.length, dropped: r.dropped,
                warnings: c.warnings || [], ms: Date.now() - started, sample: r.payloads[0] ? r.payloads[0].title || r.payloads[0].text.slice(0, 80) : null });
        } catch (err) {
            row.routes.push({ id: route.id, error: `${err.name}: ${err.message}`, ms: Date.now() - started });
            row.error = row.error ? `${row.error}; ${route.id}: ${err.message}` : `${route.id}: ${err.message}`;
        }
    }
    return row;
}

async function main(argv, env = process.env, out = line => process.stdout.write(line + '\n')) {
    const opts = parseArgs(argv);
    const http = new HttpClient({ env });
    out(`collect:smoke — live, keyless routes only (UA: ${http.ua})`);
    const rows = [];
    for (const src of SOURCES) {
        if (opts.only && !opts.only.has(src.slug)) continue;
        const row = await smokeSource(src, env, http);
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
    main(process.argv.slice(2)).then(code => process.exit(code)).catch((err) => {
        process.stderr.write(`collect:smoke: FAILED — ${err.message}\n`);
        process.exit(2);
    });
}

module.exports = { main, smokeRoutes, smokeSource, parseArgs };
