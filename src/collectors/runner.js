// src/collectors/runner.js
// One collection job through the REAL pipeline (ADR 0001):
//
//   for each requested source (registry order):
//     gate  — sourceStatus(): only 'collecting' sources run (kill switches,
//             missing credentials, blocked: never fetched), then the
//             database kill switch (data_sources.collection_disabled_at, F10-10)
//     refusal — src/collectors/refusal.js: a source that refused access
//             (401/403/451, bot wall, robots) is skipped through its
//             cooldown and reported 'blocked_by_source' (F10-5); a clean
//             probe starts a 24 h probation during which a refusal keeps
//             escalating the cooldown (ADR 0001 note 2026-09-30)
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

        for (const slug of slugs) {
            const src = getSource(slug);
            if (!src) { summary.sources.push({ slug, outcome: 'error', error: 'not a registry source' }); continue; }
            const st = sourceStatus(src, env);
            const row = { slug, category: src.category, status: st.status, outcome: 'skipped', fetched: 0, kept: 0, new: 0, error: null };
            summary.sources.push(row);
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

            const claimed = await state.claim(sourceId, pollIntervalSec(src, env), o.cycle ? o.cycle.windowMs : collectWindowMs(env));
            if (!claimed) { row.reason = 'collected within its poll interval (rate limit)'; continue; }
            queried++;
            http = http || new HttpClient({ env, transport: o.transport, sleep: o.collectorCtx && o.collectorCtx.sleep, signal });
            const startedAt = new Date();
            const before = http.requests;
            const cursor = claimed.cursor || {};
            const httpCache = claimed.http_cache || {};
            // { text, err } per failure; the first one classifies the run.
            const routeErrors = [];
            const fail = (text, err) => {
                routeErrors.push({ text, err });
                if (err && err.detail) log(`[collect] ${slug}: ${text} — detail: ${err.detail}`);
            };
            let okRoutes = 0;
            let queueFailed = false;
            let collectors = [];
            try {
                collectors = buildCollectors(src, { env, http, cursor, httpCache, now: o.now, ...(o.collectorCtx || {}) });
            } catch (err) {
                fail(err.message, err);
            }
            let storeFailed = false;
            for (const c of collectors) {
                // G10-5: the route's cursor and HTTP validators as they were
                // before it ran. If any of its items fails to store, they are
                // restored, so the next run fetches those items again (a
                // moved since-id or an ETag / 304 would otherwise skip them
                // for good; a bulk file would be marked seen unstored).
                const snapshot = JSON.stringify({ cursor, httpCache });
                let routeStoreFailed = false;
                let result;
                try {
                    result = await c.collect();
                    okRoutes++;
                } catch (err) {
                    fail(`${c.route.id}: ${err.message}`, err);
                    continue;
                }
                // G10-6: problems that did not stop the route (a broken or
                // refused feed of a multi-feed source, a skipped message) are
                // part of the run's errors, last_error and classification.
                for (const w of result.warnings || []) fail(`${c.route.id}: ${w.text}`, w.err);
                row.fetched += result.fetched;
                row.kept += result.payloads.length;
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
                if (routeStoreFailed) {
                    storeFailed = true;
                    const prev = JSON.parse(snapshot);
                    for (const k of Object.keys(cursor)) delete cursor[k];
                    Object.assign(cursor, prev.cursor);
                    for (const k of Object.keys(httpCache)) delete httpCache[k];
                    Object.assign(httpCache, prev.httpCache);
                }
            }
            const classified = routeErrors.map(e => classifyError(e.err));
            // F10-5: any refused route refuses the source (the source said no).
            const refused = refusalOf(classified);
            // G10-5: a store failure makes the run an error too.
            const ok = okRoutes > 0 && !refused && !queueFailed && !storeFailed;
            row.outcome = ok ? 'ok' : 'error';
            row.error = routeErrors.length ? scrub(routeErrors.map(e => e.text).join('; '), env) : null;
            const refusedIdx = refused ? classified.findIndex(c => c.error_kind === refused.kind) : -1;
            const cls = routeErrors.length ? classified[refusedIdx >= 0 ? refusedIdx : 0] : { error_kind: null, http_status: null };
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
                const p = await state.endCooldown(sourceId);
                if (p) log(`[collect] ${slug}: probe succeeded — on probation until ${new Date(p.probation_until).toISOString()} (refusal count ${p.refusal_count} kept)`);
            } else if (ok && refusal && refusal.refusal_count > 0 && probationOver(refusal, Date.now())) {
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
                responseHeaders: refused ? refusalHeaders : null,
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
