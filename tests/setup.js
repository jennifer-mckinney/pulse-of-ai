// tests/setup.js
// Runs before each test FILE (setupFilesAfterFramework in jest.config.js).
// Truncates all data tables so each test suite starts with a clean slate.
// Schema (tables, indexes) is preserved — only rows are removed.

'use strict';

const { dbTransaction, closePool } = require('../src/db/connection');

// Tables in dependency order (children before parents) to respect FK constraints.
// All listed in a single TRUNCATE so PostgreSQL handles cross-table deps atomically.
const TABLES = [
    'relevance_gold_labels',
    'relevance_gold_items',
    'reddit_subreddit_rankings',
    'reddit_api_budget',
    'reddit_maintenance',
    'user_platform_sightings',
    'pseudonymous_users',
    'maintenance_state',
    'compaction_log',
    'monthly_source_rollups',
    'monthly_topic_rollups',
    'post_embeddings',
    'data_retention_log',
    'discourse_results',
    'relevance_results',
    'sentiment_results',
    'decision_audit_log',
    'watchdog_notifications',
    'watchdog_state',
    'alert_resolution_approvals',
    'alert_resolutions',
    'alert_events',
    'bias_window_assessments',
    'bias_window_runs',
    'bias_assessments',
    'source_gate_events',
    'correlation_gate_events',
    'source_terms_snapshots',
    'admission_rule_hits',
    'source_run_daily',
    'source_runs',
    'source_collection_state',
    'source_route_state',
    'raw_posts',
    'processing_jobs',
    'methodology_errata',
    'methodology_versions',
    'data_sources',
].join(', ');

beforeEach(async () => {
    // CASCADE handles any FK dependencies not covered by the ordering above
    // The gold tables (migration 070) refuse TRUNCATE unless the transaction
    // opts in; this test harness (test DB only) is the one caller that does.
    await dbTransaction(async (client) => {
        await client.query("SET LOCAL pulse.gold_allow_truncate = 'on'");
        await client.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    });
});

// Every test file gets its own module registry, so its own pg Pool (up to
// PG_POOL_MAX connections). globalTeardown runs in yet another context and
// cannot end these pools; left open, the idle connections of consecutive
// files pile up for idleTimeoutMillis (30 s) and the full suite hits
// Postgres's max_connections ("sorry, too many clients already"). End this
// file's pool once it is done. A file that already closed it is fine.
afterAll(async () => {
    try {
        await closePool();
    } catch (err) {
        if (!/more than once/.test(err.message)) throw err;
    }
});
