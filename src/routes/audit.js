// src/routes/audit.js
// GET /api/audit/:post_id
//
// Returns the full decision trail for a single raw post.
// This is the explainability endpoint — every inference is traceable to:
//   - The exact model and version used
//   - The input fingerprint (keyed — see below; never raw content)
//   - The full scored output
//   - The plain-English justification from methodology_versions
//
// input_hash exposure: decision_audit_log.input_hash stores an UNSALTED
// SHA-256 of post content — internal immutable join key, never modified.
// The API exposes HMAC-SHA256(AUDIT_HASH_KEY, storedHash) instead; when the
// key is unset the field is OMITTED entirely (never raw).
//
// Returns:
//   200 { post: {...}, decisions: [...] }
//   400 if post_id is not a valid UUID
//   404 if the post does not exist
//   500 on DB error (no stack trace returned to client)

'use strict';

const crypto           = require('crypto');
const { Router }       = require('express');
const { dbGet, dbAll } = require('../db/connection');

const router = Router();

// Route-init warning (once): without a key the endpoint silently drops the
// input fingerprint, which operators should know about before wondering why
// external consumers can't see it.
/* istanbul ignore start -- AUDIT_HASH_KEY is always set in test environment */
if (!process.env.AUDIT_HASH_KEY) {
    console.warn(
        '[audit] AUDIT_HASH_KEY is not set — input_hash will be omitted from '
        + '/api/audit responses. Generate one with: openssl rand -hex 32',
    );
}
/* istanbul ignore end */

// UUID v4 regex — used to validate path params before hitting the DB
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/audit/:post_id', async (req, res) => {
    try {
        const { post_id } = req.params;

        if (!UUID_REGEX.test(post_id)) {
            return res.status(400).json({ error: 'Invalid post ID: must be a UUID' });
        }

        // Fetch the raw post with source info
        const post = await dbGet(
            `SELECT
                rp.id,
                rp.content,
                rp.location,
                rp.collected_at,
                ds.category AS source_category,
                ds.name     AS source_name
             FROM raw_posts rp
             JOIN data_sources ds ON ds.id = rp.source_id
             WHERE rp.id = $1`,
            [post_id],
        );

        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }

        // Fetch all decision audit records for this post, joined with methodology metadata
        const decisions = await dbAll(
            `SELECT
                dal.decision_type,
                dal.model_name,
                mv.version   AS methodology_version,
                mv.config,
                mv.justification,
                dal.input_hash,
                dal.output,
                dal.confidence,
                dal.created_at
             FROM decision_audit_log dal
             JOIN methodology_versions mv ON mv.id = dal.methodology_version_id
             WHERE dal.raw_post_id = $1
             ORDER BY dal.created_at ASC`,
            [post_id],
        );

        // input_hash is keyed to prevent offline hash-confirmation of post
        // content (security review L1, 2026-07-06): the stored value is an
        // unsalted SHA-256 of the content, so returning it raw would let
        // anyone confirm a guessed post text offline. External log consumers
        // verify content in their own systems; the DB value stays untouched
        // as the internal immutable join key. Key read per-request so tests
        // (and rotations) see the current environment.
        const auditKey = process.env.AUDIT_HASH_KEY;
        const exposed = decisions.map((d) => {
            const { input_hash, ...rest } = d;
            if (!auditKey) return rest;  // no key → omit, NEVER fall back to raw
            return {
                ...rest,
                input_hash: crypto
                    .createHmac('sha256', auditKey)
                    .update(input_hash)
                    .digest('hex'),
            };
        });

        return res.json({
            post: {
                id:              post.id,
                content_snippet: post.content.slice(0, 120),
                location:        post.location,
                source_category: post.source_category,
                source_name:     post.source_name,
                collected_at:    post.collected_at,
            },
            decisions: exposed,
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[audit] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
