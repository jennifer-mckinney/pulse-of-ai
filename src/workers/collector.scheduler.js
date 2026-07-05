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
    const sources = await dbAll(
        'SELECT id, name, source_type, config FROM data_sources WHERE active = true',
    );

    if (!sources || sources.length === 0) {
        return 0;
    }

    // Spread sources evenly across the collection window (thundering-herd guard)
    const staggerMs = Math.floor(COLLECT_WINDOW_MS / sources.length);

    let scheduled = 0;
    for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        const queue  = QUEUE_BY_TYPE[source.source_type];

        if (!queue) {
            // Unknown type = data problem, not a scheduler crash: skip and keep going
            console.warn(
                `[scheduler] unknown source_type "${source.source_type}" for source "${source.name}" — skipping`,
            );
            continue;
        }

        await queue.add(
            'collect',
            {
                sourceId:   source.id,
                sourceName: source.name,
                sourceType: source.source_type,
                config:     source.config,
            },
            {
                repeat: { every: COLLECT_WINDOW_MS },  // one collection per window
                delay:  i * staggerMs,                 // staggered start across the window
            },
        );
        scheduled++;
    }

    return scheduled;
}

module.exports = { scheduleAllSources, COLLECT_WINDOW_MS, QUEUE_BY_TYPE };
