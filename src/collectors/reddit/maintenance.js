// src/collectors/reddit/maintenance.js
// The Reddit background jobs, run by the worker every MAINTENANCE_MS
// (src/workers/start.js):
//
//   1. (moved, P10-2) the 48 h text retention now runs for every source in
//      the worker's repeatable `maintenance` job (src/collectors/retention.js,
//      src/workers/maintenance.worker.js) — ALWAYS, whatever the gate: it
//      needs no API access.
//   2. deletion re-check, every retention.recheckHours (6 h)
//      (./recheck.js), and
//   3. subreddit discovery, daily (./discovery.js + selection.saveSnapshot)
//      — both only while Reddit's gate status is 'collecting' (approved
//      credentials set, no kill switch, contact URL set), the database kill
//      switch is off and Reddit is not in its refused state.
//
// Each API job is claimed atomically in reddit_maintenance (migration 025):
// one worker runs it; a claim older than LEASE_MS is considered abandoned.
// A job is marked completed only when it finished; an incomplete one
// (budget exhausted, failed batches) is retried on the next tick. Its
// requests use the shared budget with a reserve (budget.runAllowance), so
// collection runs keep their share.

'use strict';

const { dbGet, dbRun } = require('../../db/connection');
const { getSource, sourceStatus, collectWindowMs } = require('../../config/source-registry');
const { HttpClient } = require('../http');
const state = require('../state');
const { refusalGate } = require('../refusal');
const { classifyError, AccessDeniedError } = require('../errors');
const { scrub } = require('../redact');
const { RedditApi } = require('./api');
const { DbBudget, runAllowance } = require('./budget');
const { recheckDeletions } = require('./recheck');
const { discoverSubreddits } = require('./discovery');
const { saveSnapshot } = require('./selection');

const SLUG = 'reddit';
const MAINTENANCE_MS = 5 * 60 * 1000;
const DISCOVERY_EVERY_HOURS = 24;
const LEASE_MS = 30 * 60 * 1000;

/** Claim a job when it is due. @returns {Promise<boolean>} */
async function claimJob(job, everyHours) {
    await dbRun('INSERT INTO reddit_maintenance (job) VALUES ($1) ON CONFLICT (job) DO NOTHING', [job]);
    const row = await dbGet(
        `UPDATE reddit_maintenance
         SET last_started_at = NOW(), updated_at = NOW()
         WHERE job = $1
           AND (last_completed_at IS NULL OR last_completed_at <= NOW() - make_interval(hours => $2))
           AND (last_started_at IS NULL OR last_started_at <= NOW() - make_interval(secs => $3)
                OR (last_completed_at IS NOT NULL AND last_completed_at >= last_started_at))
         RETURNING job`,
        [job, everyHours, LEASE_MS / 1000],
    );
    return !!row;
}

async function finishJob(job, { complete, stats = null, errorKind = null }) {
    await dbRun(
        `UPDATE reddit_maintenance
         SET last_completed_at = CASE WHEN $2 THEN NOW() ELSE last_completed_at END,
             -- an incomplete run releases its claim so the next tick retries
             last_started_at = CASE WHEN $2 THEN last_started_at ELSE NULL END,
             last_outcome = $3, last_error_kind = $4, last_stats = $5::jsonb, updated_at = NOW()
         WHERE job = $1`,
        [job, complete, errorKind ? 'error' : (complete ? 'ok' : 'incomplete'), errorKind, stats ? JSON.stringify(stats) : null],
    );
}

/** Why the API jobs may not run now, or null. */
async function apiGateReason(env) {
    const src = getSource(SLUG);
    const st = sourceStatus(src, env);
    if (st.status !== 'collecting') return st.reason;
    const ids = await state.sourceIdsBySlug([SLUG]);
    const sourceId = ids.get(SLUG);
    if (!sourceId) return 'data_sources row missing — run `npm run seed`';
    if (await state.dbKillSwitch(sourceId)) return 'kill switch (database)';
    // Migration 073: the per-route database kill switch (Reddit's one route).
    const routeKills = await state.routeKillSwitches(sourceId);
    if (routeKills.length) {
        const rst = sourceStatus(src, env, { routeKills });
        if (rst.status !== 'collecting') return rst.reason;
    }
    const gate = refusalGate(await state.getRefusal(sourceId), SLUG, env, Date.now());
    if (gate.state === 'cooldown') return gate.reason;
    return null;
}

/**
 * @param {{ env?: object, transport?: Function, log?: Function, api?: RedditApi }} [o]
 * @returns {Promise<object>} what ran
 */
async function runRedditMaintenance({ env = process.env, transport, log = () => {}, api = null } = {}) {
    // The 48 h text retention runs in the worker's repeatable `maintenance`
    // job for every source (src/collectors/retention.js, P10-2).
    const out = {};
    const closed = await apiGateReason(env);
    if (closed) return { ...out, api: `skipped: ${closed}` };
    const src = getSource(SLUG);
    // Grumpy #1 (diagnosis 2026-10-01): the stored rate-limit holds apply
    // here too, and a rate limit met here is held — and saved on Reddit's
    // row — for every later request (this run's and the collector's).
    const http = api ? null : new HttpClient({ env, transport, holds: await state.loadHolds() });
    const client = api || new RedditApi({
        http,
        env,
        budget: new DbBudget(),
        reserve: runAllowance(collectWindowMs(env)),
        requestOptions: extra => ({ minIntervalMs: src.rateLimit.minIntervalMs, robots: false, ...extra }),
    });
    // Copilot review: a step that REJECTS (finishJob, claimJob, the refusal
    // write) after an earlier request established a hold must not lose that
    // hold — a restarted worker would poll Reddit at once. The drained changes
    // are saved (best effort) and the error continues, as the runner does for
    // a failure in its route loop.
    try {
        for (const [job, everyHours, run] of [
            ['recheck', src.retention.recheckHours, async () => {
                const r = await recheckDeletions({ api: client, log });
                return { complete: r.complete, stats: r };
            }],
            ['discovery', DISCOVERY_EVERY_HOURS, async () => {
                const d = await discoverSubreddits({ api: client, env });
                if (!d.complete) return { complete: false, stats: d.stats };
                const row = await saveSnapshot({
                    windowStart: d.windowStart, windowEnd: d.windowEnd, minPosts: d.minPosts, top: d.top,
                    selected: d.selected, ranking: d.ranking, exclusions: d.exclusions, stats: d.stats,
                });
                return { complete: true, stats: { ...d.stats, selected: d.selected, applied: row.applied } };
            }],
        ]) {
            if (!(await claimJob(job, everyHours))) continue;
            try {
                const r = await run();
                await finishJob(job, r);
                out[job] = r;
                log(`[reddit] ${job}: ${r.complete ? 'completed' : 'incomplete, retried next tick'}`);
            } catch (err) {
                const cls = classifyError(err);
                await finishJob(job, { complete: false, errorKind: cls.error_kind });
                out[job] = { error: cls.error_kind };
                log(`[reddit] ${job} failed: ${scrub(err && err.message, env)}`);
                // Grumpy N2: Reddit refused us (a 401/403/451, or the 5th
                // body-only rate limit escalated by the HTTP client — fail
                // closed): the refused state applies exactly as in a collection
                // run, and no further job asks Reddit this tick.
                if (err instanceof AccessDeniedError) {
                    const sourceId = (await state.sourceIdsBySlug([SLUG])).get(SLUG);
                    if (sourceId) {
                        // The state row may not exist yet (never collected).
                        await dbRun('INSERT INTO source_collection_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING', [sourceId]);
                        const r = await state.recordRefusal(sourceId,
                            { kind: cls.error_kind, status: cls.http_status, headers: err.headers || null }, SLUG);
                        log(`[reddit] REFUSED by the source during ${job} — refusal ${r.refusal_count}, cooldown until ${new Date(r.refused_until).toISOString()}`);
                    }
                    break;
                }
            }
        }
    } catch (err) {
        if (http) await state.saveHoldChanges(http.drainHoldChanges(), http.holds, { env }).catch(serr => log(`[reddit] could not save the rate-limit holds (${scrub(serr && serr.message, env)})`));
        throw err;
    }
    // Grumpy #1 / N2: the hold changes of this run are saved, so the
    // collector (and the next maintenance tick) honours them.
    if (http) await state.saveHoldChanges(http.drainHoldChanges(), http.holds, { env });
    return out;
}

module.exports = { runRedditMaintenance, claimJob, finishJob, apiGateReason, MAINTENANCE_MS, DISCOVERY_EVERY_HOURS, LEASE_MS };
