#!/usr/bin/env bash
# scripts/test/freshen-seed.sh
# Re-freshens the dev-seed posts so the E2E suite never decays.
#
# Root cause (docs/evidence/e2e-findings/2026-09-28-dev-seed-staleness.md):
# any e2e run more than ~1h after the last seed/ingest ages every seeded post
# out of the trailing-hour window, the frontend's honest-zero path renders an
# all-zero snapshot, and the truthfulness spec legitimately fails. The fix is
# environmental, not code: shift collected_at forward IN PLACE, preserving the
# posts' relative spacing, so the newest post sits 10 minutes ago and the
# seeded distribution lands back inside the trailing hour.
#
# Runs against the database named by POSTGRES_DB on POSTGRES_PORT. The e2e
# globalSetup invokes it with POSTGRES_DB=pulse_of_ai_e2e (the suite's
# isolated database). It shifts EVERY post's collected_at, so it refuses any
# database that is not an e2e database or named in FIXTURE_DB_ALLOW
# (scripts/lib/fixture-db-guard.js, diagnosis 2026-10-01) — run bare it used
# to rewrite the dev database's real collection times. Uses the project's
# own node/pg connection so no local psql client is required. Safe to
# re-run; a no-op when raw_posts is empty.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

node - <<'EOF'
'use strict';
require('dotenv').config();
// Never the dev database (diagnosis 2026-10-01): refused before connecting.
try { require('./scripts/lib/fixture-db-guard').assertFixtureTarget(process.env); } catch (err) { console.error(require('./src/collectors/redact').scrub(`freshen-seed: ${err.message}`)); process.exit(1); }
const { dbGet, closePool } = require('./src/db/connection');

(async () => {
    // Single statement — same SQL the staleness finding recorded, with a
    // guard so an empty table is a clean no-op instead of a NULL shift.
    const row = await dbGet(`
        WITH shifted AS (
            UPDATE raw_posts
            SET collected_at = collected_at
                + (NOW() - INTERVAL '10 minutes' - (SELECT MAX(collected_at) FROM raw_posts))
            WHERE EXISTS (SELECT 1 FROM raw_posts)
            RETURNING 1
        )
        SELECT COUNT(*)::int AS refreshed FROM shifted
    `);
    console.log(`freshen-seed: shifted collected_at for ${row.refreshed} raw_posts (newest now 10 minutes ago).`);
    await closePool();
})().catch((err) => {
    console.error('freshen-seed: FAILED —', err.message);
    process.exit(1);
});
EOF
