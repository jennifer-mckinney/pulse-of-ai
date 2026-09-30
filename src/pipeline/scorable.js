// src/pipeline/scorable.js
// The one loader every scoring stage uses (PR #22 grumpy H1).
//
// raw_posts.content is NOT NULL: retention (src/collectors/retention.js)
// REPLACES a post's text with a removal notice and sets text_removed_at.
// A stage that only checked for empty content would score the notice — a
// backlogged ingest job or a sweep retry running after the window ended
// would then write permanent decision_audit_log rows describing nothing.
// loadScorablePost refuses such a post with a TextRemovedError (code
// 'TEXT_REMOVED', unrecoverable: retrying cannot bring the text back);
// the ingest worker completes the job as a recorded no-op.

'use strict';

const { dbGet } = require('../db/connection');

class TextRemovedError extends Error {
    constructor(postId, stage, removedAt) {
        super(`${stage}: post ${postId} text removed by retention; not scored`);
        this.name = 'TextRemovedError';
        this.code = 'TEXT_REMOVED';
        this.unrecoverable = true;
        this.postId = postId;
        this.removedAt = removedAt || null;
    }
}

/**
 * @param {string} postId
 * @param {string} stage  the caller's name, for the error text
 * @returns {Promise<{ content: string }>}
 */
async function loadScorablePost(postId, stage) {
    const post = await dbGet('SELECT content, text_removed_at FROM raw_posts WHERE id = $1', [postId]);
    if (!post || !post.content) throw new Error(`${stage}: post ${postId} not found`);
    if (post.text_removed_at) throw new TextRemovedError(postId, stage, post.text_removed_at);
    return post;
}

const isTextRemoved = (err) => !!(err && err.code === 'TEXT_REMOVED');

module.exports = { loadScorablePost, TextRemovedError, isTextRemoved };
