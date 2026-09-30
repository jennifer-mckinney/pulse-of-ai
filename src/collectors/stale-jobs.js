// src/collectors/stale-jobs.js
// Stale-job sweeper (P10-18). A process that dies mid-run leaves its
// processing_jobs row 'running' forever: POST /api/refresh already fails its
// own stale 'api' row before answering (F10-8), but nothing closed rows of
// the other one-shot runs — standup / demo population and manual
// `npm run collect` — or refresh rows when nobody calls refresh again. The
// maintenance job (src/workers/maintenance.worker.js) marks every such row
// 'running' that made NO PROGRESS for STALE_JOB_MINUTES (default 30, or
// REFRESH_STALE_MINUTES for api rows) as failed, with the reason. PR #22
// P1-4: progress is the runner's heartbeat, processing_jobs.last_progress_at
// (migration 040), touched before and after every source — never the job's
// age, so a long live run is not closed. The runner's own transitions are
// guarded (WHERE status = 'running'), so a swept job is never flipped back
// to 'completed'. Cron
// cycles are not touched: closeCycles owns them (hard age cap). A job whose
// run holds reserved scoring slots is 'awaiting_retries', not 'running', and
// is finalized by closeCycles too.

'use strict';

const { dbAll } = require('../db/connection');

// The triggers of every one-shot run that leaves a 'running' row: 'api'
// (POST /api/refresh, src/routes/refresh.js), 'standup' (scripts/populate.js
// through the runner), 'demo' (scripts/populate.js demo feed) and 'manual'
// (scripts/collect.js). 'cron' rows are cycles (closeCycles). No producer
// inserts rows of any other trigger. 'startup', listed only in migration 001's
// column comment, has no producer and no CHECK constraint admits or
// requires it, so it is not swept.
const SWEPT_TRIGGERS = Object.freeze(['api', 'standup', 'demo', 'manual']);
const mins = (v, d) => { const n = parseInt(v || '', 10); return Number.isFinite(n) && n > 0 ? n : d; };

/** @returns {Promise<{ failed: Array<{ id, triggered_by }> }>} */
async function sweepStaleJobs({ env = process.env } = {}) {
    const staleMin = mins(env.STALE_JOB_MINUTES, 30);
    const apiMin = mins(env.REFRESH_STALE_MINUTES, staleMin);
    const rows = await dbAll(
        `UPDATE processing_jobs
         SET status = 'failed', completed_at = NOW(),
             error_details = COALESCE(error_details || E'\\n', '')
                 || 'stale: no progress for ' || (CASE WHEN triggered_by = 'api' THEN $2::int ELSE $1::int END)::text
                 || ' minutes (the process that ran it stopped); closed by the stale-job sweeper'
         WHERE status = 'running'
           AND triggered_by = ANY($3::text[])
           AND COALESCE(last_progress_at, started_at) < NOW() - make_interval(mins => CASE WHEN triggered_by = 'api' THEN $2::int ELSE $1::int END)
         RETURNING id, triggered_by`,
        [staleMin, apiMin, SWEPT_TRIGGERS],
    );
    return { failed: rows };
}

module.exports = { sweepStaleJobs, SWEPT_TRIGGERS };
