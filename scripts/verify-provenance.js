#!/usr/bin/env node
// scripts/verify-provenance.js
// Decision D2: prove that a stored post came from a given upstream item.
//
//   npm run verify-provenance -- --post <post_uuid> --url <original URL> [--id <original id>] [--json]
//
// Recomputes the provenance fingerprint
//   HMAC-SHA256(PROVENANCE_KEY or AUDIT_HASH_KEY,
//               source_slug + ":" + upstream id + ":" + source URL)
// (src/collectors/provenance.js) and compares it, timing-safe, with the
// fingerprint stored on the post at collection (raw_posts.provenance_fingerprint).
//
// The upstream id: --id when given; else the id kept in the stored external
// id when it was stored in the clear (`<route>:<id>`); else the URL itself
// (collectors use the link as the id when an item has none). An id that was
// identity-bearing was stored only as its fingerprint, so its holder must
// pass it with --id; the stored id fingerprint is then checked too.
// Nothing is written.
//
// Exit codes:
//   0  MATCH — the original reproduces the stored fingerprint
//   1  NO MATCH
//   2  usage error, unknown post, or database failure
//   3  the post has no provenance fingerprint (collected before ingest@1.3.0,
//      demo content, or no key was configured), or no key is configured now

'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { provenanceKey, verify, hmac } = require('../src/collectors/provenance');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'usage: npm run verify-provenance -- --post <post_uuid> --url <original URL> [--id <original id>] [--json]';

function flag(args, name) {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    return v === undefined || v.startsWith('--') ? null : v;
}

/** @returns {{ postId, url, id, json } | { error }} */
function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : [];
    const postId = flag(args, '--post');
    const url = flag(args, '--url');
    const id = flag(args, '--id');
    if (!postId || url === null || id === null || (url === undefined && id === undefined)) return { error: USAGE };
    if (!UUID_REGEX.test(postId)) return { error: `invalid post id '${postId}': must be a UUID\n${USAGE}` };
    return { postId, url: url === undefined ? '' : url, id: id === undefined ? null : id, json: args.includes('--json') };
}

async function loadPost(db, postId) {
    return db.dbGet(
        `SELECT rp.id, rp.external_id, rp.provenance_fingerprint,
                rp.raw_payload->>'source_slug' AS source_slug,
                rp.raw_payload->>'route'       AS route
         FROM raw_posts rp WHERE rp.id = $1`,
        [postId],
    );
}

/**
 * Pure verification of one stored post against a claimed original.
 * @returns {{ result: 'MATCH'|'NO MATCH'|'NO FINGERPRINT'|'NO KEY', idUsed: string|null, idCheck: boolean|null }}
 */
function verifyPost(post, { url, id }, key) {
    if (!post.provenance_fingerprint) return { result: 'NO FINGERPRINT', idUsed: null, idCheck: null };
    if (!key) return { result: 'NO KEY', idUsed: null, idCheck: null };
    const prefix = `${post.route}:`;
    const storedId = post.route && post.external_id.startsWith(prefix) ? post.external_id.slice(prefix.length) : null;
    const clearId = storedId && !storedId.startsWith('fp:') ? storedId : null;
    const candidates = [...new Set([id, clearId, url].filter(v => typeof v === 'string' && v !== ''))];
    for (const rawId of candidates) {
        const r = verify({ key, slug: post.source_slug, rawId, url, stored: post.provenance_fingerprint });
        if (r.match) {
            // A fingerprinted external id must be the fingerprint of the same id.
            let idCheck = null;
            if (storedId && storedId.startsWith('fp:')) {
                const want = Buffer.from(`fp:${hmac(key, `id:${post.route}:${rawId}`)}`);
                const got = Buffer.from(storedId);
                idCheck = want.length === got.length && crypto.timingSafeEqual(want, got);
                if (!idCheck) continue;
            }
            return { result: 'MATCH', idUsed: rawId, idCheck };
        }
    }
    return { result: 'NO MATCH', idUsed: null, idCheck: null };
}

const EXIT = { MATCH: 0, 'NO MATCH': 1, 'NO FINGERPRINT': 3, 'NO KEY': 3 };

/**
 * CLI entry, injectable for tests.
 * @param {string[]} argv
 * @param {{ db?, env?, out?, err? }} io
 * @returns {Promise<number>} exit code
 */
async function main(argv, io = {}) {
    const out = io.out || ((line) => process.stdout.write(line + '\n'));
    const err = io.err || ((line) => process.stderr.write(line + '\n'));
    const parsed = parseArgs(argv);
    if (parsed.error) { err(parsed.error); return 2; }
    const db = io.db || require('../src/db/connection');
    let post;
    try {
        post = await loadPost(db, parsed.postId);
    } catch (e) {
        err(`verify-provenance: database error — ${e.message}`);
        return 2;
    }
    if (!post) { err(`verify-provenance: post ${parsed.postId} not found`); return 2; }
    const v = verifyPost(post, parsed, provenanceKey(io.env || process.env));
    if (parsed.json) {
        out(JSON.stringify({ post: post.id, source: post.source_slug, ...v }, null, 2));
    } else {
        out(`post ${post.id} (source ${post.source_slug || 'unknown'})`);
        out(`stored fingerprint: ${post.provenance_fingerprint || '(none)'}`);
        if (v.result === 'NO FINGERPRINT') out('this post has no provenance fingerprint (collected before ingest@1.3.0, demo content, or no key was configured)');
        if (v.result === 'NO KEY') out('no PROVENANCE_KEY or AUDIT_HASH_KEY is configured — the fingerprint cannot be recomputed');
        if (v.result === 'MATCH') out(`the original reproduces it (upstream id: ${v.idUsed === parsed.url ? 'the URL' : 'as given'}${v.idCheck ? '; the stored id fingerprint matches too' : ''})`);
        out(`RESULT: ${v.result}`);
    }
    return EXIT[v.result];
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

module.exports = { parseArgs, verifyPost, loadPost, main, USAGE };
