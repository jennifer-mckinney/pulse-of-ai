// tests/setup.js
// Runs before each test FILE (setupFilesAfterFramework in jest.config.js).
// Truncates all data tables so each test suite starts with a clean slate.
// Schema (tables, indexes) is preserved — only rows are removed.

'use strict';

const { dbRun } = require('../src/db/connection');

// Tables in dependency order (children before parents) to respect FK constraints.
// All listed in a single TRUNCATE so PostgreSQL handles cross-table deps atomically.
const TABLES = [
    'reddit_subreddit_rankings',
    'reddit_api_budget',
    'reddit_maintenance',
    'user_platform_sightings',
    'pseudonymous_users',
    'compaction_log',
    'monthly_source_rollups',
    'monthly_topic_rollups',
    'post_embeddings',
    'data_retention_log',
    'discourse_results',
    'relevance_results',
    'sentiment_results',
    'decision_audit_log',
    'alert_resolutions',
    'alert_events',
    'bias_assessments',
    'source_gate_events',
    'source_terms_snapshots',
    'source_run_daily',
    'source_runs',
    'source_collection_state',
    'raw_posts',
    'processing_jobs',
    'methodology_errata',
    'methodology_versions',
    'data_sources',
].join(', ');

beforeEach(async () => {
    // CASCADE handles any FK dependencies not covered by the ordering above
    await dbRun(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
});
