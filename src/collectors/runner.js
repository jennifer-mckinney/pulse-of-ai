// src/collectors/runner.js
// One collection job through the REAL pipeline (ADR 0001):
//
//   for each requested source (registry order):
//     gate  — sourceStatus(): only 'collecting' sources run (kill switches,
//             missing credentials, blocked: never fetched), then the
//             database kill switch (data_sources.collection_disabled_at, F10-10)
//             and the per-route database kill switch (source_route_state,
//             migration 073): a disabled route is never fetched
//     refusal — src/collectors/refusal.js: a source that refused access
//             (401/403/451, bot wall, robots) is skipped through its
//             cooldown and reported 'blocked_by_source' (F10-5); a clean
//             probe starts a 24 h probation during which a refusal keeps
//             escalating the cooldown (ADR 0001 note 2026-09-30)
//     rate limit — src/collectors/rate-limit.js (diagnosis 2026-10-01): a
//             host that rate-limited us (429, or a 403 with positive
//             evidence) is backed off until the source's time, for EVERY
//             source (one holds map per run, merged from all rows); a
//             route whose hosts are all held is skipped without a request,
//             and the whole source ('rate_limited') when every route is.
//             NOT a refusal: no refusal count, probation or critical alert
//             (the 5th body-only rate limit in a row is one — fail closed)
//     claim — state.claim(): the source's poll interval is honoured across
//             processes (worker schedule + POST /api/refresh)
//     fetch — one collector per open route (src/collectors), through the
//             polite HTTP client
//     store — storeRawPost(): allowlisted payload, PII backstop, city-level
//             location, dedup on (source, external id)
//     score — scorePost(): sentiment, relevance, discourse, each with its
//             decision_audit_log row under the CURRENT methodology versions;
//             a scoring failure queues an `ingest` retry for that post
//   then, for the job:
//     bias  — runBiasChecks() over the job's scored posts (when any), once
//             no scoring of the job is outstanding: here when none is,
//             else by closeCycles when the job's last reserved slot frees
//     embed — one `embed` job per new post passing the relevance gate
//             (relevance score >= 1/21, one lexicon term matched; registered
//             in relevance@1.2.0 — EMBED_GATE_MIN_SCORE, src/pipeline/relevance.js)
//     job   — processing_jobs completed with the genuine posts_collected /
//             posts_processed (posts audited under the job, whoever scored
//             them) / sources_queried counts
//
// Errors (F10-1): every error string is scrubbed (src/collectors/redact.js —
// no env secret, raw or URL-encoded, and no credential query parameter
// survives) before it is stored, logged or returned, and is classified
// (errors.js classifyError) into { error_kind, http_status } — the only
// error information the public API serves.
//
// Job rows: a caller-owned job (POST /api/refresh pre-creates one) is always
// completed. Otherwise the job row is created LAZILY, at the first NEW post:
// a scheduled run that stores nothing (304 Not Modified, all duplicates,
// gated) writes only its source_runs row (job_id NULL), so processing_jobs
// stays one row per job that actually processed posts — not ~18k empty rows
// a day from 31 sources on a 2–3 minute cadence.
//
// Queues and the HTTP transport are injected so the runner is testable on
// recorded fixtures without Redis or the network.

'use strict';

const { dbGet, dbAll, dbRun, dbTransaction } = require('../db/connection');
const { SOURCES, getSource, sourceStatus, pollIntervalSec, collectWindowMs } = require('../config/source-registry');
const { buildCollectors } = require('./index');
const { HttpClient } = require('./http');
const state = require('./state');
const { storeRawPost, scorePost } = require('../pipeline/ingest');
const { resolveCurrentMethodology } = require('../pipeline/methodology');
const { runBiasChecks } = require('../pipeline/bias');
const { EMBED_GATE_MIN_SCORE } = require('../pipeline/relevance');
const cycle = require('./cycle');
const { scrub } = require('./redact');
const { classifyError } = require('./errors');
const { refusalGate, refusalOf, resetEnv, probationOver, BLOCKED_BY_SOURCE } = require('./refusal');
const rateLimit = require('./rate-limit');
const counters = require('./admission-counters');

const { RATE_LIMITED } = rateLimit;

/** Default queue hooks: lazily bind BullMQ (opening Redis only when needed). */
function defaultQueues() {
    let q = null;
    const get = () => (q = q || require('../queues/index'));
    return {
        // PR #22 P1-5: deterministic job ids (src/queues/pending.js), so a
        // second enqueue of the same post is a no-op while the first exists.
        enqueueEmbeds: ids => get().embedQueue.addBulk(require('../queues/pending').embedJobs(ids)),
        enqueueIngestRetry: data => get().ingestQueue.add('ingest-retry', data, { jobId: `retry-${data.rawPostId}` }),
        // P10-12: scoring off the collect event loop — one ingest job per
        // new post, deduplicated per post.
        enqueueIngest: data => get().ingestQueue.add('ingest-score', data, { jobId: `score-${data.rawPostId}` }),
    };
}

/**
 * @param {object} o
 * @param {string[]} [o.slugs]        registry slugs (default: every registry source)
 * @param {string}   [o.triggeredBy]  processing_jobs.triggered_by
 * @param {string}   [o.jobId]        an existing processing_jobs row to complete
 * @param {object}   [o.env]
 * @param {Function} [o.transport]    HTTP transport (fixtures in tests)
 * @param {object}   [o.queues]       { enqueueEmbeds, enqueueIngestRetry }
 * @param {Function} [o.now]
 * @param {Function} [o.log]
 * @param {AbortSignal} [o.signal]    collection deadline (G10-9)
 * @param {number}   [o.deadlineMs]   deadline from now, when no signal
 * @param {object}   [o.collectorCtx] extra collector context (imapFactory, sleep)
 * @param {'inline'|'queue'} [o.scoreVia]  P10-12: 'queue' (the worker's
 *                    collect jobs) enqueues one `ingest` job per new post
 *                    instead of scoring on the collect event loop; each holds
 *                    a slot on its job (inflight_runs) until it scored, so the
 *                    cycle's bias checks wait for it (G10-2), and an enqueue
 *                    failure is a run error with the post left to the
 *                    unscored sweep (G10-4). Default 'inline' (CLI, populate).
 * @param {{ windowMs: number }} [o.cycle]  scheduled per-source run: score
 *                    under the shared collection-cycle job (src/collectors/
 *                    cycle.js), which runs the bias checks when it closes
 * @returns {Promise<object>} summary
 */
async function runCollection(o = {}) {
    const env = o.env || process.env;
    const rawLog = o.log || (() => {});
    const log = (m) => rawLog(scrub(m, env));
    const slugs = o.slugs || SOURCES.map(s => s.slug);
    const queues = o.queues || defaultQueues();
    // G10-9: an optional collection deadline (o.signal, or o.deadlineMs).
    // Once it fires no further source starts and in-flight requests abort.
    // G10-16: a scheduled (cycle) run gets a deadline of half the collection
    // window by default, so one slow source cannot overrun into the next
    // cycle and hold the cycle open.
    const deadlineMs = o.deadlineMs || (o.cycle && !o.signal ? Math.round(o.cycle.windowMs / 2) : null);
    const signal = o.signal || (deadlineMs ? AbortSignal.timeout(deadlineMs) : null);

    let jobId = o.jobId || null;
    let joinedCycle = false;   // G10-2: this run is in the cycle's inflight_runs
    let queried = 0;
    const newPostIds = [];     // posts scored by this run (counted even if it throws)
    const scoreVia = o.scoreVia === 'queue' ? 'queue' : 'inline';
    let queuedForScoring = 0;
    const ensureJob = async () => {
        if (!jobId && o.cycle) {
            jobId = await cycle.currentCycleJob(o.cycle.windowMs);
            joinedCycle = true;
            summary.jobId = jobId;
        } else if (!jobId) {
            const job = await dbGet(
                `INSERT INTO processing_jobs (triggered_by, status, sources_queried, last_progress_at)
                 VALUES ($1, 'running', $2, NOW()) RETURNING id`,
                [o.triggeredBy || 'cron', slugs.length],
            );
            jobId = job.id;
            summary.jobId = jobId;
        }
        return jobId;
    };
    // PR #22 P1-4: the progress heartbeat of a one-shot job (cycle jobs are
    // closed by closeCycles, not the sweeper). False once the job is no
    // longer 'running' (the stale-job sweeper closed it): the run then starts
    // no further source and never writes the row again.
    let swept = false;
    const touch = async () => {
        if (!jobId || o.cycle || swept) return !swept;
        const r = await dbGet(
            `UPDATE processing_jobs SET last_progress_at = NOW() WHERE id = $1 AND status = 'running' RETURNING id`, [jobId]);
        if (!r) {
            swept = true;
            log(`[collect] job ${jobId} is no longer running (closed by the stale-job sweeper); no further source starts`);
        }
        return !swept;
    };

    const summary = {
        jobId, sources: [], postsCollected: 0, postsProcessed: 0, scoringRetries: 0,
        embedQueued: 0, byCategory: {}, bias: null, errors: [],
    };

    try {
        const mv = await resolveCurrentMethodology();
        const ids = await state.sourceIdsBySlug(slugs);
        let http = null;
        // The run's ONE rate-limit holds map (hostname → hold), shared by
        // the HTTP client (security F5).
        const runHolds = Object.create(null);

        for (const slug of slugs) {
            const src = getSource(slug);
            if (!src) { summary.sources.push({ slug, outcome: 'error', error: 'not a registry source' }); continue; }
            const st = sourceStatus(src, env);
            const row = { slug, category: src.category, status: st.status, outcome: 'skipped', fetched: 0, kept: 0, new: 0, error: null };
            summary.sources.push(row);
            // Migration 073 (grumpy #7): routes switched off by env are named
            // in the summary too; the database check below adds its own.
            if (st.disabledRoutes.length) row.disabledRoutes = st.disabledRoutes;
            if (st.status !== 'collecting') { row.reason = st.reason; continue; }
            if (!(await touch())) {
                row.reason = 'the job was closed as stale before this source started';
                continue;
            }
            if (signal && signal.aborted) {
                row.reason = 'collection deadline reached before this source started';
                log(`[collect] ${slug}: skipped — ${row.reason}`);
                continue;
            }
            const sourceId = ids.get(slug);
            if (!sourceId) { row.outcome = 'error'; row.error = 'data_sources row missing — run `npm run seed`'; continue; }

            // F10-10: the database kill switch applies at once, in every
            // process (no container recreate needed).
            const killed = await state.dbKillSwitch(sourceId);
            if (killed) {
                row.status = 'disabled';
                row.reason = `kill switch (database): disabled${killed.by ? ` by ${killed.by}` : ''}${killed.reason ? ` — ${killed.reason}` : ''}`;
                continue;
            }
            // Migration 073: the per-route database kill switch, read before
            // every run like the source switch. A disabled route is never
            // built (no request); when every route that would run is
            // disabled, the source is skipped as 'disabled'.
            const routeKills = await state.routeKillSwitches(sourceId);
            if (routeKills.length) {
                const rst = sourceStatus(src, env, { routeKills });
                row.disabledRoutes = rst.disabledRoutes;
                if (rst.status !== 'collecting') { row.status = rst.status; row.reason = rst.reason; continue; }
            }
            // F10-5: a source that refused us is not asked again until its
            // cooldown ends (then one probe) or an operator resets it.
            const refusal = await state.getRefusal(sourceId);
            // Wall clock, not o.now (the collectors' item clock): the refusal
            // timestamps are the database's.
            const gate = refusalGate(refusal, slug, env, Date.now());
            if (gate.state === 'cooldown') { row.status = BLOCKED_BY_SOURCE; row.reason = gate.reason; continue; }
            if (gate.state === 'reset') {
                // G5 / security L6 / grumpy L16: the reset and its
                // 'refusal_reset' gate event (actor = the named approval) are
                // written in one transaction.
                const { namedApproval } = require('../config/source-registry');
                const approvedBy = namedApproval(env).value;
                await dbTransaction(async (client) => {
                    await state.clearRefusal(sourceId, `manual reset (${resetEnv(slug)}) approved by ${approvedBy}`, { client });
                    await require('./governance').recordGateEvent({
                        sourceId, slug, event: 'refusal_reset', actor: approvedBy, approvedBy, client,
                        reason: `${resetEnv(slug)}=${String(env[resetEnv(slug)]).trim()}`,
                    });
                });
                log(`[collect] ${slug}: refusal cleared by ${resetEnv(slug)} (approved by ${approvedBy})`);
            }

            // Diagnosis 2026-10-01: rate-limit holds (per HOST, migrations
            // 075-076). Every source's stored holds are merged into the
            // run's ONE map (security F5: a host held for any source is held
            // for all), shared with the HTTP client. Every route held → the
            // source is skipped before its claim, no request.
            // Security review P3: rebuilt from the database for EVERY source (in
            // place — the HTTP client shares the object), so a hold another replica's
            // success cleared since the last source never lingers in this run.
            const stored = await state.loadHolds();
            for (const k of Object.keys(runHolds)) delete runHolds[k];
            rateLimit.mergeHolds(runHolds, stored, Date.now());
            const myHosts = rateLimit.sourceHosts(src, env);
            const held = rateLimit.holdGate(src, env, runHolds, Date.now(), { routeKills });
            if (held.state === 'all') {
                // A 5xx's Retry-After hold is honoured but is not a rate limit.
                row.status = held.kind === 'server' ? 'backing_off' : RATE_LIMITED;
                row.reason = held.reason;
                // A server backoff is not a rate limit: its own field (grumpy 13).
                row[held.kind === 'server' ? 'backoffUntil' : 'rateLimitedUntil'] = held.until;
                await state.saveHolds(sourceId, { hosts: myHosts, view: runHolds, routes: held.routes, src, env, routeKills });
                log(`[collect] ${slug}: skipped — ${held.reason}`);
                continue;
            }

            const claimed = await state.claim(sourceId, pollIntervalSec(src, env, { routeKills }), o.cycle ? o.cycle.windowMs : collectWindowMs(env));
            if (!claimed) { row.reason = 'collected within its poll interval (rate limit)'; continue; }
            queried++;
            http = http || new HttpClient({ env, transport: o.transport, sleep: o.collectorCtx && o.collectorCtx.sleep, signal, holds: runHolds });
            http.drainHoldChanges();   // only this source's changes are saved on its row
            const startedAt = new Date();
            const before = http.requests;
            const cursor = claimed.cursor || {};
            // ONE hold store (PR #44 unified into #45): a PR #44
            // `retry-after:<host>` key still in the HTTP cache (written by a
            // previous-release worker during a rolling deploy; migration 077
            // copied the stored ones) is folded into the run's holds as a
            // change of this source — persisted by saveHolds below, outside
            // the HTTP cache, so the G10-5 rollback can never drop it — and
            // removed from the cache, which holds validators only.
            const legacy = rateLimit.legacyHolds(claimed.http_cache || {}, Date.now());
            const httpCache = legacy.cache;
            for (const [host, hold] of Object.entries(legacy.holds)) http.holdAlso(host, hold);
            // { text, err } per failure; the first one classifies the run.
            const routeErrors = [];
            const fail = (text, err) => {
                routeErrors.push({ text, err });
                if (err && err.detail) log(`[collect] ${slug}: ${text} — detail: ${err.detail}`);
            };
            let okRoutes = 0;
            let queueFailed = false;
            let collectors = [];
            // Routes (or feeds) not requested because their host is still
            // backing off: skipped, never a failure.
            const heldRoutes = [];
            try {
                collectors = buildCollectors(src, { env, http, cursor, httpCache, now: o.now, ...(o.collectorCtx || {}), routeKills });
            } catch (err) {
                fail(err.message, err);
            }
            let storeFailed = false;
            // Operator log (worker stdout only — never the API or mail): the holds this source's
            // run set or cleared, with the real host.
            const logHolds = (changes) => {
                for (const [h, e] of changes) {
                    log(`[collect] ${slug}: hold ${e ? `set on ${scrub(h, env)} until ${e.until} (${e.signal || 'unclassified'}, streak ${e.count})` : `cleared on ${scrub(h, env)} (a success)`}`);
                }
            };
            // Relevance-accuracy R1: the routes' dropped counters, summed
            // onto this run's source_runs row (counts only).
            const droppedByRoute = [];
            // Security review F7: a takedown issued while this source's
            // earlier routes ran applies before its next route — both
            // database switches are read again before every route after the
            // first (the first was gated just above). A failed read skips the
            // route: a takedown never fails open.
            const stillOpen = async (routeId) => {
                try {
                    if (await state.dbKillSwitch(sourceId)) return 'kill switch (database): the source was disabled during this run';
                    const now = await state.routeKillSwitches(sourceId);
                    const rst = sourceStatus(src, env, { routeKills: now });
                    if (rst.status !== 'collecting' || !rst.openRoutes.includes(routeId)) {
                        return 'kill switch (database): the route was disabled during this run';
                    }
                    return null;
                } catch (err) {
                    return `the kill switches could not be read again (${err.message}); the route is not fetched`;
                }
            };
            let gated = false;
            // Security review M1: a throw anywhere in the route loop (a DB
            // error while storing, a queue failure that escapes) must not lose
            // a rate-limit hold learned earlier in the loop — the restart would
            // re-poll a host that just limited us. The hold is saved, then the
            // error continues unchanged.
            try {
                for (const c of collectors) {
                    if (gated) {
                        const why = await stillOpen(c.route.id);
                        if (why) {
                            (row.skippedRoutes = row.skippedRoutes || []).push({ route: c.route.id, reason: why });
                            log(`[collect] ${slug}/${c.route.id}: skipped — ${why}`);
                            continue;
                        }
                    }
                    gated = true;
                    // G10-5: the route's cursor and HTTP validators as they were
                    // before it ran. If any of its items fails to store, they are
                    // restored, so the next run fetches those items again (a
                    // moved since-id or an ETag / 304 would otherwise skip them
                    // for good; a bulk file would be marked seen unstored).
                    const snapshot = JSON.stringify({ cursor, httpCache });
                    let routeStoreFailed = false;
                    let result;
                    if (rateLimit.routeHeld(c.route, env, runHolds, Date.now())) {
                        heldRoutes.push(c.route.id);
                        continue;
                    }
                    try {
                        result = await c.collect();
                        okRoutes++;
                    } catch (err) {
                        if (err && err.held === true) { heldRoutes.push(c.route.id); continue; }
                        fail(`${c.route.id}: ${err.message}`, err);
                        continue;
                    }
                    // G10-6: problems that did not stop the route (a broken or
                    // refused feed of a multi-feed source, a skipped message) are
                    // part of the run's errors, last_error and classification.
                    // A feed not requested because its host is backing off is not.
                    for (const w of result.warnings || []) {
                        if (w.err && w.err.held === true) heldRoutes.push(c.route.id);
                        else fail(`${c.route.id}: ${w.text}`, w.err);
                    }
                    row.fetched += result.fetched;
                    row.kept += result.payloads.length;
                    // Only a route that fetched items evaluated any: a route that
                    // returned nothing contributes no dropped counts (NULL, not 0).
                    if (result.fetched > 0) droppedByRoute.push(result.dropped);
                    for (const payload of result.payloads) {
                        let stored;
                        try {
                            stored = await storeRawPost(payload, sourceId, { ingestMvId: mv.ingestMvId, admissionMvId: mv.admissionMvId });
                        } catch (err) {
                            routeStoreFailed = true;
                            fail(`${c.route.id}: store failed: ${err.message}`, Object.assign(new Error('store'), { kind: 'store' }));
                            continue;
                        }
                        if (!stored.isNew) continue;
                        row.new++;
                        await ensureJob();
                        if (scoreVia === 'queue') {
                            // The slot is reserved BEFORE the enqueue, so the
                            // cycle cannot close between the two (G10-2).
                            await cycle.reserveRetry(jobId);
                            try {
                                await queues.enqueueIngest({ rawPostId: stored.postId, sourceId, jobId, reserved: true });
                                queuedForScoring++;
                            } catch (qerr) {
                                await cycle.releaseRetry(jobId).catch(() => {});
                                // G10-4: never swallowed; the sweep re-queues it.
                                queueFailed = true;
                                fail(`${c.route.id}: the scoring job could not be queued (${qerr.message})`,
                                    Object.assign(new Error('queue'), { kind: 'queue' }));
                            }
                            continue;
                        }
                        try {
                            await scorePost(stored.postId, jobId, mv);
                            newPostIds.push(stored.postId);
                        } catch (err) {
                            summary.scoringRetries++;
                            // The retry holds a slot on this job until it has
                            // scored, so the job's bias checks wait for it.
                            await cycle.reserveRetry(jobId);
                            try {
                                await queues.enqueueIngestRetry({ rawPostId: stored.postId, sourceId, jobId, reserved: true });
                                log(`[collect] ${slug}: scoring failed for ${stored.postId} (${err.message}) — queued for retry`);
                            } catch (qerr) {
                                await cycle.releaseRetry(jobId).catch(() => {});
                                // G10-4: never swallowed. The run is an error; the
                                // unscored post is re-queued by the sweep
                                // (src/collectors/sweep.js) within 24 h.
                                queueFailed = true;
                                fail(`${c.route.id}: scoring failed and the retry could not be queued (${qerr.message})`,
                                    Object.assign(new Error('queue'), { kind: 'queue' }));
                            }
                        }
                    }
                    // R1: this route's admission rule counts for today (UTC), under
                    // the admission_filter version that ran. Counts only. Written
                    // only when every item stored: a route whose store failed is
                    // fetched and evaluated again by the next run (G10-5), which
                    // would count the same items twice. A failed write is a run
                    // warning (G10-6): it never costs a post.
                    if (!routeStoreFailed) {
                        try {
                            await counters.recordRuleHits({
                                sourceId, source: src, route: c.route.id, admissionMvId: mv.admissionMvId, tally: result.ruleHits,
                            });
                        } catch (err) {
                            fail(`${c.route.id}: admission counters not recorded: ${err.message}`, err);
                        }
                    }
                    if (routeStoreFailed) {
                        storeFailed = true;
                        const prev = JSON.parse(snapshot);
                        for (const k of Object.keys(cursor)) delete cursor[k];
                        Object.assign(cursor, prev.cursor);
                        // Validators roll back. A rate-limit hold learned in this
                        // route is NOT in the HTTP cache (it lives in the run's
                        // holds, saved to rate_limited_hosts), so it is never
                        // rolled back (PR #44 Copilot re-review).
                        for (const k of Object.keys(httpCache)) delete httpCache[k];
                        Object.assign(httpCache, prev.httpCache);
                    }
                }
            } catch (loopErr) {
                const lostChanges = http.drainHoldChanges();
                logHolds(lostChanges);
                await state.saveHolds(sourceId, {
                    hosts: myHosts, changes: lostChanges, view: runHolds,
                    routes: rateLimit.holdGate(src, env, runHolds, Date.now(), { routeKills }).routes, src, env, routeKills,
                }).catch(serr => log(`[collect] ${slug}: could not save the rate-limit holds (${scrub(serr.message, env)})`));
                throw loopErr;
            }
            const classified = routeErrors.map(e => classifyError(e.err));
            // Diagnosis 2026-10-01: the run's rate limit (if any). Its hold
            // is already in the run's map (http.js); it is never passed to
            // the refused state.
            const limitedIdx = classified.findIndex(c => c.error_kind === RATE_LIMITED);
            const limitedErr = limitedIdx >= 0 ? routeErrors[limitedIdx].err : null;
            const rateLimitHeaders = limitedErr && limitedErr.headers && Object.keys(limitedErr.headers).length
                ? limitedErr.headers : null;
            const after = rateLimit.holdGate(src, env, runHolds, Date.now(), { routeKills });
            // Grumpy #10: per host, merged under a row lock — never a blind
            // overwrite of another run's newer hold.
            const savedChanges = http.drainHoldChanges();
            logHolds(savedChanges);
            await state.saveHolds(sourceId, {
                hosts: myHosts, changes: savedChanges, view: runHolds, routes: after.routes,
                limited: !!limitedErr, headers: rateLimitHeaders, src, env, routeKills,
            });
            if (heldRoutes.length) log(`[collect] ${slug}: not requested (host backoff after a rate limit or a server error's Retry-After, honoured): ${[...new Set(heldRoutes)].join(', ')}`);
            if (okRoutes === 0 && routeErrors.length === 0 && heldRoutes.length > 0) {
                // Every route that would have run was held (e.g. a hold
                // learned after the pre-claim gate): nothing was requested,
                // so this is a skip — not a failure, not a run row. Grumpy
                // #9: the progress heartbeat still beats, and a source that
                // sent nothing is not counted as queried. (Its claim stands:
                // it is next asked one poll interval after this attempt.)
                if (http.requests === before) queried--;
                row.status = after.kind === 'server' ? 'backing_off' : RATE_LIMITED;
                row.reason = after.reason || 'every route is backing off after a rate limit';
                row[after.kind === 'server' ? 'backoffUntil' : 'rateLimitedUntil'] = after.until;
                await touch();
                continue;
            }
            // F10-5: any refused route refuses the source (the source said no).
            const refused = refusalOf(classified);
            // G10-5: a store failure makes the run an error too.
            const ok = okRoutes > 0 && !refused && !queueFailed && !storeFailed;
            row.outcome = ok ? 'ok' : 'error';
            row.error = routeErrors.length ? scrub(routeErrors.map(e => e.text).join('; '), env) : null;
            const refusedIdx = refused ? classified.findIndex(c => c.error_kind === refused.kind) : -1;
            // The run's classification: a refusal first, then a rate limit
            // (grumpy #8: its headers are stored with it), else the first error.
            const leadIdx = refusedIdx >= 0 ? refusedIdx : (limitedIdx >= 0 ? limitedIdx : 0);
            const cls = routeErrors.length ? classified[leadIdx] : { error_kind: null, http_status: null };
            row.errorKind = cls.error_kind;
            row.httpStatus = cls.http_status;
            if (row.error) summary.errors.push(`${slug}: ${row.error}`);
            summary.postsCollected += row.kept;
            summary.byCategory[src.category] = (summary.byCategory[src.category] || 0) + row.new;
            await state.saveOutcome(sourceId, {
                cursor, httpCache, ok, itemCount: row.kept, newPosts: row.new,
                error: row.error, errorKind: row.errorKind, httpStatus: row.httpStatus,
            });
            // Diagnosis 2026-09-30 (option D): the refusal's allow-listed,
            // scrubbed response headers (http.js refusalHeaders; never a
            // cookie, credential or body), logged and stored with the refusal.
            const refusedErr = refusedIdx >= 0 ? routeErrors[refusedIdx].err : null;
            const refusalHeaders = refusedErr && refusedErr.headers && Object.keys(refusedErr.headers).length
                ? refusedErr.headers : null;
            if (limitedErr) row.rateLimitedUntil = after.until;
            if (limitedErr && !refused) {
                // Grumpy #13: only when nothing was refused (the refusal
                // line below says what happened otherwise).
                if (after.state === 'all') row.status = RATE_LIMITED;
                log(`[collect] ${slug}: RATE LIMITED (not a refusal) — ${limitedErr.host ? rateLimit.publicHostName(limitedErr.host) : 'host'}: ${after.reason || 'backing off'}`);
                if (rateLimitHeaders) log(`[collect] ${slug}: rate-limit response headers ${JSON.stringify(rateLimitHeaders)}`);
            }
            if (refused) {
                const r = await state.recordRefusal(sourceId, { ...refused, headers: refusalHeaders }, slug);
                row.status = BLOCKED_BY_SOURCE;
                row.refusalCount = r.refusal_count;
                row.reason = `refused (${refused.kind}${refused.status ? ` HTTP ${refused.status}` : ''}); refusal ${r.refusal_count},`
                    + ` cooldown until ${new Date(r.refused_until).toISOString()}`;
                log(`[collect] ${slug}: REFUSED by the source — ${row.reason}`);
                if (refusalHeaders) log(`[collect] ${slug}: refusal response headers ${JSON.stringify(refusalHeaders)}`);
            } else if (ok && refusal && refusal.access_denied_at && gate.state === 'probe') {
                // Probation (ADR 0001 note 2026-09-30): one clean probe ends
                // the cooldown, not the count.
                const p = await state.endCooldown(sourceId, refusal.access_denied_at);
                if (p) log(`[collect] ${slug}: probe succeeded — on probation until ${new Date(p.probation_until).toISOString()} (refusal count ${p.refusal_count} kept)`);
            } else if (ok && refusal && !refusal.access_denied_at && refusal.refusal_count > 0 && probationOver(refusal, Date.now())) {
                // 24 h without a refusal: the count decays.
                if (await state.decayRefusal(sourceId)) log(`[collect] ${slug}: probation over — refusal count reset to 0`);
            }
            // G10-12: a run that changed nothing (304 / nothing fetched, no
            // error) is counted on the state row, not inserted.
            const unchanged = row.outcome === 'ok' && !row.error && row.fetched === 0 && row.new === 0;
            if (unchanged) await state.countUnchangedRun(sourceId);
            else await state.recordRun({
                sourceId, jobId, gateStatus: st.status, outcome: row.outcome, itemsFetched: row.fetched,
                postsNew: row.new, requests: http.requests - before, error: row.error,
                errorKind: row.errorKind, httpStatus: row.httpStatus, startedAt,
                // Migration 075: a rate-limited run keeps its headers too —
                // only under its own error kind (grumpy #8).
                responseHeaders: refused ? refusalHeaders : (cls.error_kind === RATE_LIMITED ? rateLimitHeaders : null),
                // NULL when no item was evaluated (no route fetched anything): there is no 0 to record.
                dropped: droppedByRoute.length ? counters.mergeDropped(droppedByRoute) : null,
            });
            log(`[collect] ${slug}: ${row.outcome} fetched ${row.fetched}, kept ${row.kept}, new ${row.new}${row.error ? ` — ${row.error}` : ''}`);
            await touch();
        }

        summary.postsProcessed = newPostIds.length;
        summary.queuedForScoring = queuedForScoring;
        // Copilot 4129565673: with scoring retries outstanding, a non-cycle
        // job's bias checks wait for them — the job goes to
        // 'awaiting_retries' and closeCycles finalizes it (counts from the
        // audit log, bias once) when the last retry has scored.
        let awaitingRetries = false;
        if (jobId && !o.cycle) {
            awaitingRetries = !!(await dbGet(
                `UPDATE processing_jobs
                 SET status = 'awaiting_retries', posts_collected = $2, sources_queried = $3, error_details = $4
                 WHERE id = $1 AND inflight_runs > 0 AND status = 'running' RETURNING id`,
                [jobId, summary.postsCollected, queried,
                    summary.errors.length ? summary.errors.join('\n').slice(0, 4000) : null],
            ));
            summary.awaitingRetries = awaitingRetries;
        }
        // A one-shot job with no scoring outstanding is finalized HERE, the
        // way closeCycles finalizes cycles and 'awaiting_retries' jobs: its
        // posts_processed is the number of posts scored under it
        // (decision_audit_log, cycle.jobPostsProcessed) and its bias checks
        // run when that is > 0. Counting only the posts this run scored
        // inline (newPostIds) lost every post scored by an ingest job that
        // finished BEFORE the run ended (scoreVia 'queue': posts_processed 0,
        // no per-job bias checks) and every inline-failure retry that did.
        // A job the stale-job sweeper closed meanwhile is left as it is.
        if (jobId && !o.cycle && !awaitingRetries) {
            summary.postsProcessed = await cycle.jobPostsProcessed(jobId);
            const open = summary.postsProcessed > 0 && await dbGet(
                `SELECT id FROM processing_jobs WHERE id = $1 AND status = 'running'`, [jobId]);
            if (open) {
                const bias = await runBiasChecks(jobId, mv.biasMvId);
                summary.bias = { checksRun: bias.checksRun, violationsFound: bias.violationsFound };
            }
        }
        if (newPostIds.length > 0) {
            const gated = await dbAll(
                `SELECT raw_post_id FROM relevance_results
                 WHERE raw_post_id = ANY($1::uuid[]) AND score >= $2`,
                [newPostIds, EMBED_GATE_MIN_SCORE - 1e-9],
            );
            if (gated.length) {
                try {
                    await queues.enqueueEmbeds(gated.map(r => r.raw_post_id));
                    summary.embedQueued = gated.length;
                } catch (err) {
                    summary.errors.push(scrub(`embed queue unavailable: ${err.message}`, env));
                }
            }
        }

        if (jobId && o.cycle) {
            // The cycle job stays open; closeCycles() runs its bias checks
            // (counts are added when the run leaves the cycle, below).
        } else if (jobId && !awaitingRetries) {
            // PR #22 P1-4: guarded — a job the sweeper closed stays failed
            // with its reason (a Tier-3 permanent record is never rewritten).
            const done = await dbGet(
                `UPDATE processing_jobs
                 SET status = 'completed', posts_collected = $2, posts_processed = $3,
                     sources_queried = $4, error_details = $5, completed_at = NOW()
                 WHERE id = $1 AND status = 'running' RETURNING id`,
                [jobId, summary.postsCollected, summary.postsProcessed, queried,
                    summary.errors.length ? summary.errors.join('\n').slice(0, 4000) : null],
            );
            if (!done) {
                summary.swept = true;
                log(`[collect] job ${jobId} was closed by the stale-job sweeper; its record is left as it is`);
            }
        }
        summary.sourcesQueried = queried;
        return summary;
    } catch (err) {
        if (jobId && !o.cycle) {
            await dbRun(
                `UPDATE processing_jobs SET status = 'failed', error_details = $2, completed_at = NOW()
                 WHERE id = $1 AND status = 'running'`,
                [jobId, scrub(err.message, env)],
            ).catch(() => {});
        }
        throw err;
    } finally {
        // G10-2: leave the cycle whatever happened — a run that throws after
        // scoring still accounts its posts, and the cycle can close.
        if (joinedCycle) {
            await cycle.leaveCycle(jobId, { collected: summary.postsCollected, processed: newPostIds.length, sources: queried })
                .catch(e => log(`[collect] could not leave cycle ${jobId}: ${e.message}`));
        }
    }
}

module.exports = { runCollection, defaultQueues };
