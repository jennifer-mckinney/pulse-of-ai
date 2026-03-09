// src/workers/collector.scheduler.js
// Schedules per-source collection jobs into the BullMQ collect queues.
//
// Each data source gets its own scheduled job staggered across the 2-3 minute
// refresh window. Staggering prevents a "thundering herd" where all 50 sources
// fire simultaneously and overwhelm the downstream ingest queue.
//
// Stagger strategy:
//   - Window: COLLECT_WINDOW_MS (default: 120,000ms = 2 minutes)
//   - 50 sources spread evenly = one source every 2,400ms
//   - BullMQ's repeat/cron system handles re-scheduling automatically
//
// TODO: implement scheduleAllSources() below.
// The function signature and contract are defined — fill in the body.

'use strict';

const { dbAll } = require('../db/connection');
const {
    collectRedditQueue,
    collectRssQueue,
    collectArxivQueue,
    collectScraperQueue,
} = require('../queues/index');

const COLLECT_WINDOW_MS = parseInt(process.env.COLLECT_WINDOW_MS || '120000', 10);

// Map source_type → queue
const QUEUE_BY_TYPE = {
    reddit:  collectRedditQueue,
    rss:     collectRssQueue,
    arxiv:   collectArxivQueue,
    scraper: collectScraperQueue,
};

/**
 * Load all active data sources from the DB and schedule a repeating BullMQ
 * job for each one, staggered evenly across COLLECT_WINDOW_MS.
 *
 * Each job should carry: { sourceId, sourceName, sourceType, config }
 * The repeat interval should be COLLECT_WINDOW_MS (each source collects once
 * per window).  Use BullMQ's `repeat: { every: N }` job option.
 *
 * Stagger: source at index i gets a `delay` of i * (COLLECT_WINDOW_MS / total)
 * so the 50 sources spread evenly across the window instead of all firing at once.
 *
 * @returns {Promise<number>} count of scheduled jobs
 */
async function scheduleAllSources() {
    // TODO: implement staggered scheduling
    // Hint: await dbAll('SELECT id, name, source_type, config FROM data_sources WHERE active = true')
    // Then for each source, call QUEUE_BY_TYPE[source.source_type].add(...)
    // with repeat: { every: COLLECT_WINDOW_MS } and delay: i * staggerMs
}

module.exports = { scheduleAllSources, COLLECT_WINDOW_MS, QUEUE_BY_TYPE };
