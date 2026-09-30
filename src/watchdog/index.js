// src/watchdog/index.js
// The external watchdog (PR #22 principal #12; Jennifer's decision
// "watchdog + dashboard + email").
//
// Every other alert is evaluated inside the worker, so when the worker dies
// nothing alerts. This loop runs in its OWN container (compose service
// `watchdog`, scripts/watchdog.js) and, every WATCHDOG_POLL_INTERVAL_S:
//   1. GETs /api/health and probes PostgreSQL itself (SELECT 1);
//   2. evaluates the conditions (src/watchdog/conditions.js);
//   3. compares them with the conditions it holds open: a NEW condition is
//      an "opened" transition, a condition no longer present (and not
//      unknown this poll) is a "cleared" transition;
//   4. syncs the database: one open critical alert_events row per active
//      condition (ON CONFLICT DO NOTHING, migration 050), and every open
//      watchdog alert that is no longer active is resolved with an audited
//      alert_resolutions record — so the dashboard health chip and banner
//      show it, and the record survives;
//   5. e-mails each transition (src/watchdog/notifier.js: rate-limited,
//      retried, logged to watchdog_notifications);
//   6. writes watchdog_state (last poll, e-mail status) for /api/health.
//
// Robustness: nothing in a poll can throw out of the loop. The API being
// down is itself a condition (web_unreachable) and the loop keeps polling;
// the database being down is a condition too (the alert rows are written
// once it is back, and a condition that opened and cleared in between is
// still recorded, as an already-resolved alert). The watchdog depends on
// neither web nor worker being up.

'use strict';

const { evaluate, FailedJobsWindow, CONDITIONS, conditionOf } = require('./conditions');
const { Notifier, clean } = require('./notifier');
const store = require('./store');

class Watchdog {
    /**
     * @param {{ cfg: object, db: object, fetchImpl?: Function, transport?: object,
     *           log?: Function, now?: () => Date }} o
     */
    constructor({ cfg, db, fetchImpl = globalThis.fetch, transport = null, log = defaultLog, now = () => new Date() }) {
        this.cfg = cfg;
        this.db = db;
        this.fetchImpl = fetchImpl;
        this.log = log;
        this.now = now;
        this.startedAt = now();
        this.active = new Map();      // condition → { c, since: Date, alertId: string|null }
        this.unrecorded = [];         // conditions that opened AND cleared while the DB was down
        this.failedWindow = new FailedJobsWindow();
        this.notifier = new Notifier({
            smtp: cfg.smtp,
            maxPerHour: cfg.emailMaxPerHour,
            dashboardUrl: cfg.dashboardUrl,
            transport,
            now: () => this.now().getTime(),
            onOutcome: (o) => this._logNotification(o),
        });
        this.dbUp = false;
        this.stopped = false;
        this.timer = null;
        for (const e of cfg.errors || []) this.log(`config: ${e}`);
        this.log(`started: polling ${cfg.healthUrl} every ${cfg.pollIntervalMs / 1000}s; e-mail ${cfg.emailStatus}`);
    }

    async _logNotification({ ev, outcome, recipients, error }) {
        this.log(`e-mail ${ev.kind} ${ev.condition}: ${outcome}${error ? ` (${error})` : ''}`);
        if (!this.dbUp) return;
        await store.recordNotification(this.db, {
            alertId: ev.alertId, condition: ev.condition, kind: ev.kind, outcome, recipients, error,
        });
    }

    /**
     * Seed the open conditions from the database, so a restarted watchdog
     * does not e-mail conditions it already reported; re-queue an "opened"
     * e-mail that was never settled. Never throws.
     */
    async init() {
        try {
            await store.probe(this.db);
            this.dbUp = true;
            for (const row of await store.listOpen(this.db)) {
                const condition = conditionOf(row.alert_type);
                if (!condition || !CONDITIONS[condition]) continue;
                const d = row.details || {};
                this.active.set(condition, {
                    c: { condition, title: CONDITIONS[condition], summary: d.summary || '', details: {} },
                    since: new Date(row.created_at),
                    alertId: row.id,
                });
            }
            for (const row of await store.unsettledOpenAlerts(this.db)) {
                const a = this.active.get(conditionOf(row.alert_type));
                if (a) this.notifier.enqueue({ kind: 'opened', condition: a.c.condition, title: a.c.title,
                    summary: a.c.summary, at: a.since, alertId: row.id });
            }
            if (this.active.size) this.log(`resumed ${this.active.size} open condition(s): ${[...this.active.keys()].join(', ')}`);
        } catch (err) {
            this.dbUp = false;
            this.log(`init: database unreachable (${clean(err && err.message, 200)}); starting with no open conditions`);
        }
    }

    async _fetchHealth() {
        try {
            const res = await this.fetchImpl(this.cfg.healthUrl, {
                signal: AbortSignal.timeout(this.cfg.httpTimeoutMs),
                headers: { accept: 'application/json' },
            });
            if (!res.ok) return { health: null, httpStatus: res.status, fetchError: null };
            try {
                const body = await res.json();
                if (!body || typeof body !== 'object') throw new Error('not an object');
                return { health: body, httpStatus: res.status, fetchError: null };
            } catch {
                return { health: null, httpStatus: res.status, fetchError: 'response is not valid JSON' };
            }
        } catch (err) {
            const cause = err && err.cause && err.cause.code ? ` (${err.cause.code})` : '';
            const name = err && err.name === 'TimeoutError' ? `timed out after ${this.cfg.httpTimeoutMs} ms` : (err && err.message) || 'fetch failed';
            return { health: null, httpStatus: null, fetchError: clean(name + cause, 200) };
        }
    }

    /** One poll. Never throws; returns what happened (tests read it). */
    async pollOnce() {
        const now = this.now();
        const { health, httpStatus, fetchError } = await this._fetchHealth();
        let dbReachable;
        try { dbReachable = await store.probe(this.db); } catch { dbReachable = false; }
        this.dbUp = dbReachable;

        const queueFailedRise = this.failedWindow.record(now.getTime(), health && health.worker && health.worker.queues);
        const { conditions, unknown } = evaluate({ health, httpStatus, fetchError, dbReachable },
            { now, thresholds: this.cfg.thresholds, queueFailedRise });

        const current = new Map(conditions.map(c => [c.condition, c]));
        const opened = [];
        const cleared = [];
        for (const [cond, c] of current) {
            const a = this.active.get(cond);
            if (a) { a.c = c; continue; }
            const entry = { c, since: now, alertId: null };
            this.active.set(cond, entry);
            opened.push(entry);
        }
        for (const [cond, a] of [...this.active]) {
            if (current.has(cond) || unknown.includes(cond)) continue;
            this.active.delete(cond);
            cleared.push(a);
            if (!a.alertId) this.unrecorded.push({ ...a, clearedAt: now });
        }

        if (dbReachable) await this._syncDb(now, unknown);

        for (const a of opened) {
            this.notifier.enqueue({ kind: 'opened', condition: a.c.condition, title: a.c.title, summary: a.c.summary,
                at: now, alertId: a.alertId });
        }
        for (const a of cleared) {
            this.notifier.enqueue({ kind: 'cleared', condition: a.c.condition, title: a.c.title,
                summary: `no longer detected (last: ${a.c.summary})`, at: now, since: a.since, alertId: a.alertId });
        }
        const email = await this.notifier.deliver();

        if (dbReachable) {
            try {
                await store.writeState(this.db, {
                    startedAt: this.startedAt,
                    lastPollAt: now,
                    pollIntervalS: Math.round(this.cfg.pollIntervalMs / 1000),
                    healthReachable: Boolean(health),
                    openConditions: [...this.active.values()].map(a => ({
                        condition: a.c.condition, title: a.c.title, summary: clean(a.c.summary), since: a.since,
                    })),
                    emailConfigured: this.notifier.configured,
                    emailStatus: this.cfg.emailStatus,
                    lastEmailAt: this.notifier.lastSentAt,
                    lastEmailError: this.notifier.lastError,
                    configErrors: this.cfg.errors,
                });
            } catch (err) {
                this.log(`state write failed: ${clean(err && err.message, 200)}`);
            }
        }

        const names = (list) => list.map(a => a.c.condition).join(', ');
        this.log(`poll: health ${health ? 'ok' : `unreachable (${fetchError || `HTTP ${httpStatus}`})`}, db ${dbReachable ? 'ok' : 'unreachable'}; `
            + `open [${[...this.active.keys()].join(', ')}]`
            + (opened.length ? `; opened [${names(opened)}]` : '')
            + (cleared.length ? `; cleared [${names(cleared)}]` : ''));
        return { opened: opened.map(a => a.c.condition), cleared: cleared.map(a => a.c.condition),
            open: [...this.active.keys()], email, dbReachable, healthReachable: Boolean(health) };
    }

    /** Make the database match the active set. Errors are logged, never thrown. */
    async _syncDb(now, unknown) {
        try {
            for (const a of this.active.values()) {
                const { id } = await store.openAlert(this.db, a.c, a.since);
                if (id) a.alertId = id;
            }
            for (const row of await store.listOpen(this.db)) {
                const cond = conditionOf(row.alert_type);
                if (!cond || this.active.has(cond) || unknown.includes(cond)) continue;
                const summary = (row.details && row.details.summary) || '';
                await store.resolveAlert(this.db, cond, {
                    resolution: `cleared: the watchdog no longer detects "${CONDITIONS[cond] || cond}"`,
                    basis: { condition: cond, cleared_detected_at: now.toISOString(), last_summary: summary },
                });
            }
            while (this.unrecorded.length) {
                const u = this.unrecorded[0];
                const id = await store.recordClosed(this.db, u.c, {
                    since: u.since, clearedAt: u.clearedAt,
                    resolution: `cleared: the watchdog no longer detects "${u.c.title}" (recorded after the database became reachable)`,
                });
                this.unrecorded.shift();
                this.log(`recorded ${u.c.condition} (open ${u.since.toISOString()} → ${u.clearedAt.toISOString()}) as alert ${id}`);
            }
        } catch (err) {
            this.log(`database sync failed: ${clean(err && err.message, 200)}`);
        }
    }

    /** Poll forever (after the initial delay) until stop(). */
    async run() {
        await this.init();
        await this._sleep(this.cfg.initialDelayMs);
        while (!this.stopped) {
            try {
                await this.pollOnce();
            } catch (err) {
                /* istanbul ignore next -- pollOnce never throws; a last guard */
                this.log(`poll error: ${clean(err && err.message, 200)}`);
            }
            await this._sleep(this.cfg.pollIntervalMs);
        }
    }

    _sleep(ms) {
        if (this.stopped || ms <= 0) return Promise.resolve();
        return new Promise((resolve) => {
            this._wake = resolve;
            this.timer = setTimeout(resolve, ms);
        });
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        if (this._wake) this._wake();
    }
}

/* istanbul ignore next -- console output */
function defaultLog(msg) {
    console.log(`[watchdog] ${new Date().toISOString()} ${clean(msg, 2000)}`);
}

module.exports = { Watchdog };
