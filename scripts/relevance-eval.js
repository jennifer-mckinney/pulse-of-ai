#!/usr/bin/env node
// scripts/relevance-eval.js — `npm run relevance:eval -- [--since DATE] [--category SLUG] [--limit N] [--json]`
// Relevance-accuracy Stage 0 (P5): OFFLINE harness. Scores stored posts with
// the RELEASED scorers (relevance@current, admission_filter@1.0.0) and with
// the tiered lexicon library (src/config/ai-lexicon-tiers.js), and prints
// per-category counts and deltas (tiered AI minus current relevant).
//
// Read-only by construction: every query runs in a READ ONLY transaction,
// so a write anywhere in it fails. It writes no score, audit row or
// methodology version, and changes no production behaviour. Output is
// counts only — no post text. Local-only (assertLocalOnly): it reads every post's text.

'use strict';

require('dotenv').config();
const { oneLine } = require('../src/gold/labelling');

// A calendar date, optionally with a time (what Postgres and Date.parse agree on).
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const USAGE = 'usage: npm run relevance:eval -- [--since YYYY-MM-DD] [--category SLUG] [--limit N] [--json]';

function parseArgs(argv) {
    const args = Array.isArray(argv) ? [...argv] : [];
    const out = { since: null, category: null, limit: null, json: false };
    const value = (flag) => {
        const v = args.shift();
        if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
        return v;
    };
    while (args.length) {
        const a = args.shift();
        switch (a) {
            case '--since': out.since = value(a); break;
            case '--category': out.category = value(a); break;
            case '--limit': out.limit = Number(value(a)); break;
            case '--json': out.json = true; break;
            default: throw new Error(`unknown argument ${oneLine(a).slice(0, 60)}\n${USAGE}`);
        }
    }
    if (out.since !== null && !(DATE_RE.test(out.since) && !Number.isNaN(Date.parse(out.since)))) throw new Error(`--since must be a date, YYYY-MM-DD (got "${oneLine(out.since).slice(0, 60)}")`);
    if (out.limit !== null && (!Number.isInteger(out.limit) || out.limit <= 0)) throw new Error('--limit must be a positive integer');
    if (out.category !== null && !require('../src/config/categories').isCanonicalCategory(out.category)) {
        throw new Error(`--category must be a canonical category slug (got "${oneLine(out.category).slice(0, 60)}")`);
    }
    return out;
}

async function main(argv, { env = process.env, out = l => process.stdout.write(l + '\n') } = {}) {
    const opts = parseArgs(argv);
    require('../src/gold/labelling').assertLocalOnly(env);
    const { createAccumulator, formatReport, VERSIONS } = require('../src/gold/eval');
    const { readOnly, streamEvalRows } = require('../src/gold/store');
    const report = await readOnly(async (client) => {
        const acc = createAccumulator();
        for await (const row of streamEvalRows(client, opts)) acc.push(row);
        return acc.report();
    });
    const result = { versions: VERSIONS, filters: { since: opts.since, category: opts.category, limit: opts.limit }, ...report };
    if (opts.json) out(JSON.stringify(result, null, 2));
    else formatReport(report).forEach(l => out(l));
    return result;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    const db = require('../src/db/connection');
    main(process.argv.slice(2))
        .then(async () => { await db.closePool(); process.exit(0); })
        .catch(async (err) => {
            process.stderr.write(`relevance-eval: FAILED — ${require('../src/collectors/redact').scrub(err.message)}\n`);
            await db.closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = { main, parseArgs, USAGE };
