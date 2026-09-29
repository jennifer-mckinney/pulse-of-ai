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

function parseArgs(argv) {
    const i = argv.indexOf('--only');
    return { slugs: i >= 0 ? argv[i + 1].split(',').map(s => s.trim()).filter(Boolean) : undefined };
}

async function main(argv, out = line => process.stdout.write(line + '\n')) {
    const { slugs } = parseArgs(argv);
    const s = await runCollection({ slugs, triggeredBy: 'manual', log: out });
    out(`job ${s.jobId}: ${s.sourcesQueried} sources queried, ${s.postsCollected} items collected, `
        + `${s.postsProcessed} new posts scored, ${s.embedQueued} embed jobs queued, `
        + `bias ${s.bias ? `${s.bias.violationsFound} violation(s)` : 'not run (no new posts)'}`);
    out(`new posts by category: ${JSON.stringify(s.byCategory)}`);
    return s;
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    main(process.argv.slice(2))
        .then(async () => {
            const q = require('../src/queues/index');
            await Promise.allSettled(Object.values(q).filter(x => x && typeof x.close === 'function').map(x => x.close()));
            await db.closePool();
            process.exit(0);
        })
        .catch(async (err) => {
            process.stderr.write(`collect: FAILED — ${err.message}\n`);
            await db.closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = { main, parseArgs };
