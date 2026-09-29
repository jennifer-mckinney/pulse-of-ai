#!/usr/bin/env node
// scripts/collect.js — `npm run collect [-- --only slug1,slug2]`
// Runs ONE real collection job through the pipeline (src/collectors/runner.js):
// collect → store → sentiment / relevance / discourse (audited) → bias →
// embed jobs. Honors every gate, kill switch and poll interval. Prints the
// per-source outcome and the job's counts.

'use strict';

require('dotenv').config();
const db = require('../src/db/connection');
const { runCollection } = require('../src/collectors/runner');
const { scrub } = require('../src/collectors/redact');

const USAGE = 'usage: npm run collect [-- --only slug1,slug2]';

/** @returns {{ slugs?: string[] } | { error: string }} */
function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    const i = args.indexOf('--only');
    if (i < 0) return { slugs: undefined };
    // G10-23: `--only` without a value is a usage error, not a TypeError.
    const v = args[i + 1];
    const slugs = typeof v === 'string' && !v.startsWith('--') ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
    return slugs.length ? { slugs } : { error: `--only needs a comma-separated list of source slugs\n${USAGE}` };
}

class UsageError extends Error {}

async function main(argv, out = line => process.stdout.write(line + '\n')) {
    const parsed = parseArgs(argv);
    if (parsed.error) throw new UsageError(parsed.error);
    const { slugs } = parsed;
    const s = await runCollection({ slugs, triggeredBy: 'manual', log: out });
    out(`job ${s.jobId}: ${s.sourcesQueried} sources queried, ${s.postsCollected} items collected, `
        + `${s.postsProcessed} new posts scored, ${s.embedQueued} embed jobs queued, `
        + `bias ${s.bias ? `${s.bias.violationsFound} violation(s)` : 'not run (no new posts)'}`);
    out(`new posts by category: ${JSON.stringify(s.byCategory)}`);
    return s;
}

/**
 * G10-23: close the BullMQ queues only when the run actually loaded them (a
 * run that queued no embed or retry job never connects to Redis; requiring
 * the module just to close it opened connections for nothing).
 */
async function closeQueuesIfOpened(cache = require.cache) {
    const id = require.resolve('../src/queues/index');
    if (!cache[id]) return false;
    const q = cache[id].exports;
    await Promise.allSettled(Object.values(q).filter(x => x && typeof x.close === 'function').map(x => x.close()));
    return true;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    main(process.argv.slice(2))
        .then(async () => {
            await closeQueuesIfOpened();
            await db.closePool();
            process.exit(0);
        })
        .catch(async (err) => {
            if (err instanceof UsageError) {
                process.stderr.write(`${err.message}\n`);
                await db.closePool().catch(() => {});
                process.exit(2);
            }
            process.stderr.write(`collect: FAILED — ${scrub(err.message)}\n`);
            await closeQueuesIfOpened().catch(() => {});
            await db.closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = { main, parseArgs, closeQueuesIfOpened, UsageError, USAGE };
