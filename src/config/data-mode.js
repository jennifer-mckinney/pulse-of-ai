// src/config/data-mode.js
// Where the data on screen came from: real collection, the demo feed, or both.
//
// Authoritative signal: the post's SOURCE. scripts/populate.js writes every
// fictional post under a data_sources row with source_type 'demo' (inactive,
// named "Demo feed — <Category> (fictional)"). The source is chosen per post
// at insert time and never changes, so it classifies each post exactly.
// processing_jobs.triggered_by = 'demo' is NOT used: it describes a job, a
// job can in principle mix sources, and posts are joined to jobs only through
// their decision_audit_log rows.
//
// Modes (per window of posts):
//   'none'  — no posts in the window
//   'demo'  — every post is from a demo feed
//   'live'  — no post is from a demo feed
//   'mixed' — both
//
// UMD-free on purpose: backend-only (routes). The frontend derives the same
// mode from the per-city demo_posts counts (public/js/data.js dataModeOf),
// and tests/unit/pure/dataMode.test.js pins both to the same table.

'use strict';

const DEMO_SOURCE_TYPE = 'demo';
// data_retention_log.action of a demo purge batch (scripts/compact.js). Its
// reason JSON lists the purged post ids, so a job that later finds its post
// gone can tell a legitimate purge from a real error (src/pipeline/embeddings.js).
const DEMO_PURGE_ACTION = 'purged_demo';
const DATA_MODES = Object.freeze(['none', 'demo', 'live', 'mixed']);

/**
 * @param {number} demoPosts   posts from demo feeds in the window
 * @param {number} totalPosts  all posts in the window
 * @returns {'none'|'demo'|'live'|'mixed'}
 */
function deriveDataMode(demoPosts, totalPosts) {
    const total = Number(totalPosts) || 0;
    const demo = Math.min(Number(demoPosts) || 0, total);
    if (total <= 0) return 'none';
    if (demo === total) return 'demo';
    if (demo === 0) return 'live';
    return 'mixed';
}

module.exports = { DEMO_SOURCE_TYPE, DEMO_PURGE_ACTION, DATA_MODES, deriveDataMode };
