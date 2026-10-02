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
//   --post POST_ID [--remove-text]   erase the gold rows of one post whose text is already gone;
//                    with --remove-text (the erasure request) the post's text, embedding and
//                    text digests (content_hash, audit input_hash: replaced by HMAC-keyed values,
//                    needs AUDIT_HASH_KEY) go too, in one transaction, even when retention already
//                    removed the text (an erasure request goes through the post's text removal first: erasing
//                    only the gold rows of a post that still has text would let a later
//                    sample draw it again; retention does both in one transaction)
//   --removed        erase every item whose post is gone, has had its text
//                    removed by retention, or is empty (run it after the
//                    retention job, before reporting any gold statistic)
//
// The retention job (src/collectors/retention.js) erases a post's gold rows in the
// same transaction as its text; this tool serves erasure requests and catches up
// posts whose text went another way. Local-only (assertLocalOnly). Counts only.

'use strict';

require('dotenv').config();
const { oneLine } = require('../src/gold/labelling');

const USAGE = 'usage: npm run gold:erase -- --post POST_ID [--remove-text] | --removed';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
    const args = Array.isArray(argv) ? [...argv] : [];
    const out = { post: null, removed: false, removeText: false };
    while (args.length) {
        const a = args.shift();
        if (a === '--post') {
            const v = args.shift();
            if (v === undefined || v.startsWith('--')) throw new Error(`--post needs a value\n${USAGE}`);
            out.post = v;
        } else if (a === '--remove-text') {
            out.removeText = true;
        } else if (a === '--removed') {
            out.removed = true;
        } else {
            throw new Error(`unknown argument ${oneLine(a).slice(0, 60)}\n${USAGE}`);
        }
    }
    if (Boolean(out.post) === out.removed) throw new Error(`give exactly one of --post and --removed\n${USAGE}`);
    if (out.post && !UUID_RE.test(out.post)) throw new Error('--post must be a post UUID');
    if (out.removeText && !out.post) throw new Error(`--remove-text goes with --post\n${USAGE}`);
    return out;
}

async function main(argv, { env = process.env, out = l => process.stdout.write(l + '\n') } = {}) {
    const opts = parseArgs(argv);
    require('../src/gold/labelling').assertLocalOnly(env);
    const store = require('../src/gold/store');
    let erased = 0;
    if (opts.post && opts.removeText) {
        // Erasure request: remove the text (scrub, embedding, retention log), key its digests AND erase the gold rows in one
        // transaction; the count is what that transaction erased (never a separate, racy read).
        const r = await require('../src/collectors/retention').removeTextOnRequest(opts.post.toLowerCase());
        out(r.source ? `gold erase: text of the post ${r.removed ? 'removed' : 'was already gone (derived data erased)'} (${r.source})` : 'gold erase: no such post');
        erased = r.goldErased;
    } else if (opts.post) {
        if (!(await store.postTextGone(opts.post.toLowerCase()))) {
            throw new Error('that post still has text: add --remove-text to remove its text (scrub, embedding, retention log) and its gold rows together; '
                + 'erasing only the gold rows would let a later sample draw the post again');
        }
        erased = await store.erasePost(opts.post.toLowerCase());
    } else {
        erased = await store.eraseRemoved();
    }
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
