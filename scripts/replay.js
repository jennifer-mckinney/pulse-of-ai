#!/usr/bin/env node
// scripts/replay.js
// The audit receipt's reproduce command (P1-4):
//
//   npm run replay -- --post <post_uuid> [--json]
//
// Loads the post's stored content, its decision_audit_log rows, and the
// methodology_versions row (version + config) each decision references, then
// re-runs the deterministic src/pipeline scorers via src/audit/replay.js and
// prints PASS / DIVERGENCE / NOT RE-RUNNABLE per stage. Nothing is written.
//
// Exit codes:
//   0  every stored decision stage re-ran and matched (RESULT: PASS)
//   1  at least one stage diverged from its stored output (RESULT: DIVERGENCE)
//   2  usage error, unknown post, or database failure
//   3  no divergence, but at least one stage could not be re-run, or the post
//      has no stored decisions (RESULT: PARTIAL) — never reported as a pass

'use strict';

require('dotenv').config();
const { replayPost, formatReport } = require('../src/audit/replay');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'usage: npm run replay -- --post <post_uuid> [--json]';

/** Parse argv (without node + script). @returns {{ postId, json } | { error }} */
function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    const i = args.indexOf('--post');
    const postId = i >= 0 ? args[i + 1] : undefined;
    if (!postId) return { error: USAGE };
    if (!UUID_REGEX.test(postId)) return { error: `invalid post id '${postId}': must be a UUID\n${USAGE}` };
    return { postId, json: args.includes('--json') };
}

/**
 * Load everything a replay needs for one post.
 * @returns {Promise<{ post, decisions } | null>}  null when the post does not exist
 */
async function loadReplayInput(db, postId) {
    const post = await db.dbGet('SELECT id, content FROM raw_posts WHERE id = $1', [postId]);
    if (!post) return null;
    const decisions = await db.dbAll(
        `SELECT dal.decision_type,
                dal.model_name,
                dal.input_hash,
                dal.output,
                mv.component,
                mv.version,
                mv.model_name AS registered_model,
                mv.config
         FROM decision_audit_log dal
         JOIN methodology_versions mv ON mv.id = dal.methodology_version_id
         WHERE dal.raw_post_id = $1
         ORDER BY dal.created_at ASC, dal.id ASC`,
        [postId],
    );
    return { post, decisions };
}

/**
 * CLI entry, injectable for tests.
 * @param {string[]} argv
 * @param {{ db?, out?, err? }} io  db = src/db/connection helpers
 * @returns {Promise<number>} exit code
 */
async function main(argv, io = {}) {
    const out = io.out || ((line) => process.stdout.write(line + '\n'));
    const err = io.err || ((line) => process.stderr.write(line + '\n'));
    const parsed = parseArgs(argv);
    if (parsed.error) {
        err(parsed.error);
        return 2;
    }
    const db = io.db || require('../src/db/connection');
    let input;
    try {
        input = await loadReplayInput(db, parsed.postId);
    } catch (e) {
        err(`replay: database error — ${e.message}`);
        return 2;
    }
    if (!input) {
        err(`replay: post ${parsed.postId} not found`);
        return 2;
    }
    const report = replayPost(input);
    if (parsed.json) {
        out(JSON.stringify(report, null, 2));
    } else {
        for (const line of formatReport(report)) out(line);
    }
    return report.exitCode;
}

/* istanbul ignore next -- process entry point; main() is tested directly */
if (require.main === module) {
    const db = require('../src/db/connection');
    main(process.argv.slice(2), { db })
        .then(async (code) => {
            await db.closePool();
            process.exit(code);
        });
}

module.exports = { parseArgs, loadReplayInput, main, USAGE };
