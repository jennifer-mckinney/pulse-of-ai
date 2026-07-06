// src/routes/audit.js
// GET /api/audit/:post_id
//
// Returns the full decision trail for a single raw post.
// This is the explainability endpoint — every inference is traceable to:
//   - The exact model and version used
//   - The input hash (content fingerprint, not raw content)
//   - The full scored output
//   - The plain-English justification from methodology_versions
//
// Returns:
//   200 { post: {...}, decisions: [...] }
//   400 if post_id is not a valid UUID
//   404 if the post does not exist
//   500 on DB error (no stack trace returned to client)

'use strict';

const { Router }       = require('express');
const { dbGet, dbAll } = require('../db/connection');

const router = Router();

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

        return res.json({
            post: {
                id:              post.id,
                content_snippet: post.content.slice(0, 120),
                location:        post.location,
                source_category: post.source_category,
                source_name:     post.source_name,
                collected_at:    post.collected_at,
            },
            decisions,
        });
    } catch (err) {
        console.error('[audit] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
