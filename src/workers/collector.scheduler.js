// src/workers/collector.scheduler.js
// Registers one BullMQ v5 job scheduler per COLLECTING registry source on
// the collect queue of its source_type (collect.rss / collect.api /
// collect.bulk — the DB and registry vocabulary). Invoked by the worker
// process (src/workers/start.js) at start and every RESCHEDULE_MS.
//
//   - Only sources whose runtime gate status is 'collecting' are scheduled
//     (src/config/source-registry.js sourceStatus: kill switches, missing
//     credentials and the blocked 4 are never scheduled).
//   - Scheduler id = the source slug, so each source has its own scheduler.
//   - Cadence: every max(COLLECT_WINDOW_MS, the source's poll interval) — the
//     2–3 minute cycle, stretched where a documented rate limit needs it.
//   - Stagger via `startDate` across the window (thundering-herd guard).
//   - Stale cleanup: a scheduler whose source is no longer collecting (kill
//     switch, retired, credential removed) is removed.

'use strict';

const { dbAll } = require('../db/connection');
const { COLLECT_QUEUES } = require('../queues/index');
const {
    getSource, sourceStatus, pollIntervalSec, collectWindowMs, DEFAULT_COLLECT_WINDOW_MS,
} = require('../config/source-registry');

// Collection window: src/config/source-registry.js collectWindowMs (150 s default).
const COLLECT_WINDOW_MS = collectWindowMs();

/** Map source_type → queue. */
const QUEUE_BY_TYPE = COLLECT_QUEUES;

/**
 * @param {{ env?: object, log?: Function }} [opts]
 * @returns {Promise<number>} count of sources with an upserted scheduler
 */
async function scheduleAllSources({ env = process.env, log = () => {} } = {}) {
    const rows = await dbAll(
        `SELECT id, name, source_type FROM data_sources
         WHERE active = true AND source_type <> 'demo'
         ORDER BY name`,
    ) || [];
    const windowMs = collectWindowMs(env);

    const activeIdsByQueue = new Map();
    const schedulable = [];
    for (const row of rows) {
        const src = getSource(row.name);
        if (!src) { log(`[scheduler] '${row.name}' is not a registry source — not scheduled`); continue; }
        const st = sourceStatus(src, env);
        if (st.status !== 'collecting') continue;
        const queue = QUEUE_BY_TYPE[row.source_type];
        if (!queue) {
            log(`[scheduler] unknown source_type "${row.source_type}" for "${row.name}" — skipping`);
            continue;
        }
        if (!activeIdsByQueue.has(queue)) activeIdsByQueue.set(queue, new Set());
        activeIdsByQueue.get(queue).add(row.name);
        schedulable.push({ row, src, queue });
    }

    for (const queue of Object.values(QUEUE_BY_TYPE)) {
        const active = activeIdsByQueue.get(queue) || new Set();
        for (const scheduler of (await queue.getJobSchedulers()) || []) {
            const id = scheduler.key !== undefined ? scheduler.key : scheduler.id;
            if (!active.has(id)) await queue.removeJobScheduler(id);
        }
    }

    if (schedulable.length === 0) return 0;
    const staggerMs = Math.floor(windowMs / schedulable.length);
    const now = Date.now();
    for (let i = 0; i < schedulable.length; i++) {
        const { row, src, queue } = schedulable[i];
        await queue.upsertJobScheduler(
            row.name,
            { every: Math.max(windowMs, pollIntervalSec(src, env) * 1000), startDate: now + i * staggerMs },
            { name: 'collect', data: { slug: row.name, sourceId: row.id, sourceType: row.source_type } },
        );
    }
    log(`[scheduler] ${schedulable.length} collecting sources scheduled across ${Math.round(windowMs / 1000)}s`);
    return schedulable.length;
}

module.exports = { scheduleAllSources, collectWindowMs, COLLECT_WINDOW_MS, QUEUE_BY_TYPE, DEFAULT_COLLECT_WINDOW_MS };
