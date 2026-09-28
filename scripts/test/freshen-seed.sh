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
# Runs against the DEV database (port 5434) — the one the e2e suite's dev
# server reads. Uses the project's own node/pg connection so no local psql
# client is required. Safe to re-run; a no-op when raw_posts is empty.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

node - <<'EOF'
'use strict';
require('dotenv').config();
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
