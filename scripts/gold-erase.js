#!/usr/bin/env node
// scripts/gold-erase.js — `npm run gold:erase -- --post POST_ID | --removed`
// Relevance-accuracy Stage 0 (P3): the ERASURE path of the gold set
// (migration 070, gold_erase_post). The gold tables are append-only, so an
// erasure request, or the removal of a post's text under the retention
// rulings, would otherwise leave a permanent link to that post. Erasing blanks
// the item's raw_post_id and input_hash and its labels' input_hash and note,
// and stamps erased_at. Labels, flags, strata and weights stay (statistics
// about the sample, no text). An erased item can no longer be labelled.
//
//   --post POST_ID   erase the gold rows of one post (an erasure request)
//   --removed        erase every item whose post is gone, has had its text
//                    removed by retention, or is empty (run it after the
//                    retention job, before reporting any gold statistic)
//
// Local-only (assertLocalOnly). Prints counts only.

'use strict';

require('dotenv').config();

const USAGE = 'usage: npm run gold:erase -- --post POST_ID | --removed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
    const args = Array.isArray(argv) ? [...argv] : [];
    const out = { post: null, removed: false };
    while (args.length) {
        const a = args.shift();
        if (a === '--post') {
            const v = args.shift();
            if (v === undefined || v.startsWith('--')) throw new Error(`--post needs a value\n${USAGE}`);
            out.post = v;
        } else if (a === '--removed') {
            out.removed = true;
        } else {
            throw new Error(`unknown argument ${a}\n${USAGE}`);
        }
    }
    if (Boolean(out.post) === out.removed) throw new Error(`give exactly one of --post and --removed\n${USAGE}`);
    if (out.post && !UUID_RE.test(out.post)) throw new Error('--post must be a post UUID');
    return out;
}

async function main(argv, { env = process.env, out = l => process.stdout.write(l + '\n') } = {}) {
    const opts = parseArgs(argv);
    require('../src/gold/labelling').assertLocalOnly(env);
    const store = require('../src/gold/store');
    const erased = opts.post ? await store.erasePost(opts.post.toLowerCase()) : await store.eraseRemoved();
    out(`gold erase: ${erased} item(s) erased${opts.post ? '' : ' (posts whose text is gone)'}`);
    return { erased };
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    const db = require('../src/db/connection');
    main(process.argv.slice(2))
        .then(async () => { await db.closePool(); process.exit(0); })
        .catch(async (err) => {
            process.stderr.write(`gold-erase: FAILED — ${require('../src/collectors/redact').scrub(err.message)}\n`);
            await db.closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = { main, parseArgs, USAGE };
