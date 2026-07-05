// src/workers/collector.scheduler.js
// Registers per-source BullMQ v5 job schedulers on the collect queues.
//
// STATUS: NOT yet invoked by src/workers/start.js. No collect processors
// exist yet — collect workers (and wiring this scheduler into the worker
// entry point) land in a later phase. Until then this module is exercised
// only by its unit and Redis integration tests.
//
// Design (BullMQ v5 job schedulers, not legacy `repeat`):
//   - One job scheduler PER SOURCE, keyed by String(source.id). Distinct
//     scheduler ids prevent BullMQ from deduplicating all same-queue sources
//     into a single repeating job.
//   - Stagger via `startDate`: source at index i first fires at
//     now + i * (COLLECT_WINDOW_MS / total), spreading the 50 sources evenly
//     across the window instead of a thundering herd. (Legacy `delay` is
//     ignored by repeatable jobs — `startDate` is the supported mechanism.)
//   - Stale cleanup: before upserting, schedulers whose id is no longer in
//     the active-source set are removed, so deactivated/deleted sources stop
//     collecting without a Redis flush.

'use strict';

const { dbAll } = require('../db/connection');
const {
    collectRedditQueue,
    collectRssQueue,
    collectArxivQueue,
    collectScraperQueue,
} = require('../queues/index');

// Collection window with a guarded default: a missing, non-numeric, or
// non-positive COLLECT_WINDOW_MS env value falls back to 2 minutes instead
// of producing NaN/zero repeat intervals.
const DEFAULT_COLLECT_WINDOW_MS = 120000;
const parsedWindow = parseInt(process.env.COLLECT_WINDOW_MS || '', 10);
const COLLECT_WINDOW_MS =
    Number.isFinite(parsedWindow) && parsedWindow > 0
        ? parsedWindow
        : DEFAULT_COLLECT_WINDOW_MS;

// Map source_type → queue
const QUEUE_BY_TYPE = {
    reddit:  collectRedditQueue,
    rss:     collectRssQueue,
    arxiv:   collectArxivQueue,
    scraper: collectScraperQueue,
};

/**
 * Load all active data sources from the DB and upsert one BullMQ job
 * scheduler per source, staggered evenly across COLLECT_WINDOW_MS.
 *
 * Scheduler id: String(source.id) — one scheduler per source (upsert makes
 * re-runs idempotent). Each scheduled job is named 'collect' and carries
 * { sourceId, sourceName, sourceType, config }.
 *
 * Stale schedulers (ids not present in the current active-source set) are
 * removed from every collect queue before upserting, so sources deactivated
 * since the last run stop being collected.
 *
 * @returns {Promise<number>} count of sources with an upserted scheduler
 */
async function scheduleAllSources() {
    const sources = await dbAll(
        'SELECT id, name, source_type, config FROM data_sources WHERE active = true',
    );
    const list = sources || [];

    // Partition sources by target queue; skip unknown types (data problem,
    // not a scheduler crash) and track active scheduler ids per queue.
    const activeIdsByQueue = new Map(); // Queue → Set<string scheduler id>
    const schedulable = [];
    for (const source of list) {
        const queue = QUEUE_BY_TYPE[source.source_type];
        if (!queue) {
            console.warn(
                `[scheduler] unknown source_type "${source.source_type}" for source "${source.name}" — skipping`,
            );
            continue;
        }
        if (!activeIdsByQueue.has(queue)) activeIdsByQueue.set(queue, new Set());
        activeIdsByQueue.get(queue).add(String(source.id));
        schedulable.push({ source, queue });
    }

    // Stale cleanup: any scheduler on a collect queue whose id is not in the
    // active set belongs to a deactivated/deleted source — remove it.
    for (const queue of Object.values(QUEUE_BY_TYPE)) {
        const activeIds = activeIdsByQueue.get(queue) || new Set();
        const existing = await queue.getJobSchedulers();
        for (const scheduler of existing || []) {
            // getJobSchedulers() exposes the scheduler id as `key`
            const id = scheduler.key !== undefined ? scheduler.key : scheduler.id;
            if (!activeIds.has(id)) {
                await queue.removeJobScheduler(id);
            }
        }
    }

    if (schedulable.length === 0) {
        return 0;
    }

    // Spread sources evenly across the collection window (thundering-herd guard)
    const staggerMs = Math.floor(COLLECT_WINDOW_MS / schedulable.length);
    const now = Date.now();

    let scheduled = 0;
    for (let i = 0; i < schedulable.length; i++) {
        const { source, queue } = schedulable[i];
        await queue.upsertJobScheduler(
            String(source.id),                     // per-source scheduler id
            {
                every: COLLECT_WINDOW_MS,          // one collection per window
                startDate: now + i * staggerMs,    // staggered first run
            },
            {
                name: 'collect',
                data: {
                    sourceId:   source.id,
                    sourceName: source.name,
                    sourceType: source.source_type,
                    config:     source.config,
                },
            },
        );
        scheduled++;
    }

    return scheduled;
}

module.exports = { scheduleAllSources, COLLECT_WINDOW_MS, QUEUE_BY_TYPE };
