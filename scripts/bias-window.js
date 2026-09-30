#!/usr/bin/env node
// scripts/bias-window.js — `npm run bias:window [-- --json]`
// PR #22 decision G2 (Jennifer McKinney, 2026-09-29; ADR 0001): run the
// rolling 24 h fairness checks (bias@1.5.0) NOW, on demand. The worker also
// runs them daily (maintenance task 'daily'). Writes one bias_window_runs row
// and its bias_window_assessments (migration 060); a violation raises an
// alert like a per-cycle one. Prints a summary (or --json).

'use strict';

require('dotenv').config();

const USAGE = 'usage: npm run bias:window [-- --json]';

function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    const unknown = args.filter(a => a !== '--json');
    if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(' ')}\n${USAGE}`);
    return { json: args.includes('--json') };
}

async function main(argv, { out = l => process.stdout.write(l + '\n') } = {}) {
    const { json } = parseArgs(argv);
    const { runBiasWindow } = require('../src/pipeline/bias-window');
    const r = await runBiasWindow({ triggeredBy: 'on_demand' });
    const summary = {
        run_id: r.runId,
        version: `bias@${r.version}`,
        window_hours: r.windowHours,
        window_start: new Date(r.windowStart).toISOString(),
        window_end: new Date(r.windowEnd).toISOString(),
        posts_assessed: r.postsAssessed,
        violations_found: r.violationsFound,
        checks: ['location_concentration', 'platform_sentiment_parity', 'negative_dominance'].map((type, i) => ({
            type,
            outcome: r.results[i].isViolation ? 'violation' : (r.results[i].insufficientSample ? 'insufficient_sample' : 'within_threshold'),
            value: r.results[i].metricValue,
        })),
    };
    if (json) {
        out(JSON.stringify(summary, null, 2));
    } else {
        out(`bias window ${summary.run_id} (${summary.version}): ${summary.window_start} – ${summary.window_end}, `
            + `${summary.posts_assessed} posts, ${summary.violations_found} violation(s)`);
        for (const c of summary.checks) out(`  ${c.type}: ${c.outcome} (${Number(c.value).toFixed(3)})`);
    }
    return summary;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    const db = require('../src/db/connection');
    main(process.argv.slice(2))
        .then(async () => { await db.closePool(); process.exit(0); })
        .catch(async (err) => {
            process.stderr.write(`bias-window: FAILED — ${require('../src/collectors/redact').scrub(err.message)}\n`);
            await db.closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = { main, parseArgs, USAGE };
