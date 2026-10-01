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
//   - Route kill switches (migration 073): the env list and the database
//     rows both count — a source with every route switched off is not
//     scheduled, and a switched-off route's quota no longer sets the
//     cadence. The runner re-checks them before every run.

'use strict';

const { recordGateTransitions, recordCorrelationGate } = require('../collectors/governance');

const { dbAll } = require('../db/connection');
const state = require('../collectors/state');
const { COLLECT_QUEUES } = require('../queues/index');
const {
    getSource, sourceStatus, pollIntervalSec, collectWindowMs, DEFAULT_COLLECT_WINDOW_MS, parseDisabledRoutes, ROUTE_KILL_ENV,
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
    // Migration 073: COLLECTORS_DISABLED_ROUTES entries that name no registry
    // source hold EVERY source disabled (fail closed, sourceStatus) — say why
    // on every reschedule (an entry naming a registry source with an unknown
    // route holds that source disabled, which sourceStatus reports).
    const { invalid } = parseDisabledRoutes(env);
    if (invalid.length) {
        log(`[scheduler] ${ROUTE_KILL_ENV}: ${invalid.length} entr${invalid.length > 1 ? 'ies name' : 'y names'} no registry `
            + `source (${invalid.map(e => JSON.stringify(e)).join(', ')}); every source is held disabled until fixed — entries are "slug/route"`);
    }
    // The database route kill switches (grumpy #6). A failed read is logged
    // and scheduling uses the env alone: the runner reads them again before
    // every run and never fetches a switched-off route.
    let routeKills = new Map();
    try {
        routeKills = await state.allRouteKillSwitches();
    } catch (err) {
        log(`[scheduler] route kill switches not read (${err.message}) — scheduling from the env alone; the runner still enforces them`);
    }

    const activeIdsByQueue = new Map();
    const schedulable = [];
    for (const row of rows) {
        const src = getSource(row.name);
        if (!src) { log(`[scheduler] '${row.name}' is not a registry source — not scheduled`); continue; }
        const kills = routeKills.get(row.id) || [];
        const st = sourceStatus(src, env, { routeKills: kills });
        if (st.status !== 'collecting') continue;
        const queue = QUEUE_BY_TYPE[row.source_type];
        if (!queue) {
            log(`[scheduler] unknown source_type "${row.source_type}" for "${row.name}" — skipping`);
            continue;
        }
        if (!activeIdsByQueue.has(queue)) activeIdsByQueue.set(queue, new Set());
        activeIdsByQueue.get(queue).add(row.name);
        schedulable.push({ row, src, queue, kills });
    }

    for (const queue of Object.values(QUEUE_BY_TYPE)) {
        const active = activeIdsByQueue.get(queue) || new Set();
        for (const scheduler of (await queue.getJobSchedulers()) || []) {
            const id = scheduler.key !== undefined ? scheduler.key : scheduler.id;
            if (!active.has(id)) await queue.removeJobScheduler(id);
        }
    }

    // P10-14 / G5 / principal #19: record every gate change seen under this
    // env — also when nothing is collecting (a closing must be recorded).
    await recordGovernance(env, log);

    if (schedulable.length === 0) return 0;
    const staggerMs = Math.floor(windowMs / schedulable.length);
    const now = Date.now();
    for (let i = 0; i < schedulable.length; i++) {
        const { row, src, queue, kills } = schedulable[i];
        await queue.upsertJobScheduler(
            row.name,
            { every: Math.max(windowMs, pollIntervalSec(src, env, { routeKills: kills }) * 1000), startDate: now + i * staggerMs },
            { name: 'collect', data: { slug: row.name, sourceId: row.id, sourceType: row.source_type } },
        );
    }
    log(`[scheduler] ${schedulable.length} collecting sources scheduled across ${Math.round(windowMs / 1000)}s`);
    return schedulable.length;
}

/** Source gate transitions and the correlation gate; a failure is logged, never fatal to scheduling. */
async function recordGovernance(env, log) {
    try {
        for (const e of await recordGateTransitions({ env })) {
            log(`[scheduler] ${e.slug}: ${e.event} (${e.gate_status})${e.approved_by ? ` approved by ${e.approved_by}` : ''}`);
        }
    } catch (err) {
        log(`[scheduler] gate events not recorded: ${err.message}`);
    }
    try {
        const c = await recordCorrelationGate({ env });
        if (c) log(`[scheduler] correlation gate: ${c.status}`);
    } catch (err) {
        log(`[scheduler] correlation gate event not recorded: ${err.message}`);
    }
}

module.exports = { scheduleAllSources, collectWindowMs, COLLECT_WINDOW_MS, QUEUE_BY_TYPE, DEFAULT_COLLECT_WINDOW_MS };
