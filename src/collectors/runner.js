// src/collectors/runner.js
// One collection job through the REAL pipeline (ADR 0001):
//
//   for each requested source (registry order):
//     gate  — sourceStatus(): only 'collecting' sources run (kill switches,
//             missing credentials, blocked: never fetched)
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
//     bias  — runBiasChecks() over the job's scored posts (when any)
//     embed — one `embed` job per new post passing the relevance gate
//             (relevance score >= 1/20, registered in relevance@1.1.0)
//     job   — processing_jobs completed with the genuine posts_collected /
//             posts_processed / sources_queried counts
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

const { dbGet, dbAll, dbRun } = require('../db/connection');
const { SOURCES, getSource, sourceStatus, pollIntervalSec } = require('../config/source-registry');
const { buildCollectors } = require('./index');
const { HttpClient } = require('./http');
const state = require('./state');
const { storeRawPost, scorePost } = require('../pipeline/ingest');
const { resolveCurrentMethodology } = require('../pipeline/methodology');
const { runBiasChecks } = require('../pipeline/bias');
const { EMBED_GATE_MIN_SCORE } = require('../pipeline/relevance');
const cycle = require('./cycle');

/** Default queue hooks: lazily bind BullMQ (opening Redis only when needed). */
function defaultQueues() {
    let q = null;
    const get = () => (q = q || require('../queues/index'));
    return {
        enqueueEmbeds: ids => get().embedQueue.addBulk(ids.map(rawPostId => ({ name: 'embed-post', data: { rawPostId } }))),
        enqueueIngestRetry: data => get().ingestQueue.add('ingest-retry', data),
    };
}

/**
 * @param {object} o
 * @param {string[]} [o.slugs]        registry slugs (default: all 51)
 * @param {string}   [o.triggeredBy]  processing_jobs.triggered_by
 * @param {string}   [o.jobId]        an existing processing_jobs row to complete
 * @param {object}   [o.env]
 * @param {Function} [o.transport]    HTTP transport (fixtures in tests)
 * @param {object}   [o.queues]       { enqueueEmbeds, enqueueIngestRetry }
 * @param {Function} [o.now]
 * @param {Function} [o.log]
 * @param {object}   [o.collectorCtx] extra collector context (imapFactory, sleep)
 * @param {{ windowMs: number }} [o.cycle]  scheduled per-source run: score
 *                    under the shared collection-cycle job (src/collectors/
 *                    cycle.js), which runs the bias checks when it closes
 * @returns {Promise<object>} summary
 */
async function runCollection(o = {}) {
    const env = o.env || process.env;
    const log = o.log || (() => {});
    const slugs = o.slugs || SOURCES.map(s => s.slug);
    const queues = o.queues || defaultQueues();

    let jobId = o.jobId || null;
    const ensureJob = async () => {
        if (!jobId && o.cycle) {
            jobId = await cycle.currentCycleJob(o.cycle.windowMs);
            summary.jobId = jobId;
        } else if (!jobId) {
            const job = await dbGet(
                `INSERT INTO processing_jobs (triggered_by, status, sources_queried) VALUES ($1, 'running', $2) RETURNING id`,
                [o.triggeredBy || 'cron', slugs.length],
            );
            jobId = job.id;
            summary.jobId = jobId;
        }
        return jobId;
    };

    const summary = {
        jobId, sources: [], postsCollected: 0, postsProcessed: 0, scoringRetries: 0,
        embedQueued: 0, byCategory: {}, bias: null, errors: [],
    };

    try {
        const mv = await resolveCurrentMethodology();
        const ids = await state.sourceIdsBySlug(slugs);
        let http = null;
        const newPostIds = [];
        let queried = 0;

        for (const slug of slugs) {
            const src = getSource(slug);
            if (!src) { summary.sources.push({ slug, outcome: 'error', error: 'not a registry source' }); continue; }
            const st = sourceStatus(src, env);
            const row = { slug, category: src.category, status: st.status, outcome: 'skipped', fetched: 0, kept: 0, new: 0, error: null };
            summary.sources.push(row);
            if (st.status !== 'collecting') { row.reason = st.reason; continue; }
            const sourceId = ids.get(slug);
            if (!sourceId) { row.outcome = 'error'; row.error = 'data_sources row missing — run `npm run seed`'; continue; }

            const claimed = await state.claim(sourceId, pollIntervalSec(src, env));
            if (!claimed) { row.reason = 'collected within its poll interval (rate limit)'; continue; }
            queried++;
            http = http || new HttpClient({ env, transport: o.transport, sleep: o.collectorCtx && o.collectorCtx.sleep });
            const startedAt = new Date();
            const before = http.requests;
            const cursor = claimed.cursor || {};
            const httpCache = claimed.http_cache || {};
            const routeErrors = [];
            let okRoutes = 0;
            let collectors = [];
            try {
                collectors = buildCollectors(src, { env, http, cursor, httpCache, now: o.now, ...(o.collectorCtx || {}) });
            } catch (err) {
                routeErrors.push(err.message);
            }
            for (const c of collectors) {
                let result;
                try {
                    result = await c.collect();
                    okRoutes++;
                } catch (err) {
                    routeErrors.push(`${c.route.id}: ${err.message}`);
                    continue;
                }
                row.fetched += result.fetched;
                row.kept += result.payloads.length;
                for (const payload of result.payloads) {
                    let stored;
                    try {
                        stored = await storeRawPost(payload, sourceId);
                    } catch (err) {
                        routeErrors.push(`${c.route.id}: store failed: ${err.message}`);
                        continue;
                    }
                    if (!stored.isNew) continue;
                    row.new++;
                    await ensureJob();
                    try {
                        await scorePost(stored.postId, jobId, mv);
                        newPostIds.push(stored.postId);
                    } catch (err) {
                        summary.scoringRetries++;
                        log(`[collect] ${slug}: scoring failed for ${stored.postId} (${err.message}) — queued for retry`);
                        await queues.enqueueIngestRetry({ rawPostId: stored.postId, sourceId, jobId }).catch(() => {});
                    }
                }
            }
            const ok = okRoutes > 0;
            row.outcome = ok ? 'ok' : 'error';
            row.error = routeErrors.length ? routeErrors.join('; ') : null;
            if (row.error) summary.errors.push(`${slug}: ${row.error}`);
            summary.postsCollected += row.kept;
            summary.byCategory[src.category] = (summary.byCategory[src.category] || 0) + row.new;
            await state.saveOutcome(sourceId, { cursor, httpCache, ok, itemCount: row.kept, newPosts: row.new, error: row.error });
            await state.recordRun({
                sourceId, jobId, gateStatus: st.status, outcome: row.outcome, itemsFetched: row.fetched,
                postsNew: row.new, requests: http.requests - before, error: row.error, startedAt,
            });
            log(`[collect] ${slug}: ${row.outcome} fetched ${row.fetched}, kept ${row.kept}, new ${row.new}${row.error ? ` — ${row.error}` : ''}`);
        }

        summary.postsProcessed = newPostIds.length;
        if (newPostIds.length > 0 && !o.cycle) {
            const bias = await runBiasChecks(jobId, mv.biasMvId);
            summary.bias = { checksRun: bias.checksRun, violationsFound: bias.violationsFound };
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
                    summary.errors.push(`embed queue unavailable: ${err.message}`);
                }
            }
        }

        if (jobId && o.cycle) {
            // The cycle job stays open; closeCycles() runs its bias checks.
            await cycle.addToCycle(jobId, { collected: summary.postsCollected, processed: summary.postsProcessed, sources: queried });
        } else if (jobId) {
            await dbRun(
                `UPDATE processing_jobs
                 SET status = 'completed', posts_collected = $2, posts_processed = $3,
                     sources_queried = $4, error_details = $5, completed_at = NOW()
                 WHERE id = $1`,
                [jobId, summary.postsCollected, summary.postsProcessed, queried,
                    summary.errors.length ? summary.errors.join('\n').slice(0, 4000) : null],
            );
        }
        summary.sourcesQueried = queried;
        return summary;
    } catch (err) {
        if (jobId && !o.cycle) {
            await dbRun(
                `UPDATE processing_jobs SET status = 'failed', error_details = $2, completed_at = NOW() WHERE id = $1`,
                [jobId, err.message],
            ).catch(() => {});
        }
        throw err;
    }
}

module.exports = { runCollection, defaultQueues };
