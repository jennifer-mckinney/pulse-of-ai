// tests/unit/pure/watchdog.test.js
// The external watchdog (PR #22 principal #12): configuration, condition
// evaluation, the e-mail notifier (rate limit, retry, not-configured) and the
// poll loop's dedupe — one alert and one e-mail per NEW or CLEARED
// condition, never one per poll. No database, no network: the store is an
// in-memory fake and the SMTP transport is a recorder. The database and a
// real (fake) SMTP server are covered by tests/integration/watchdog.test.js.

'use strict';

jest.mock('../../../src/watchdog/store', () => {
    // In-memory stand-in for src/watchdog/store.js (same API).
    const s = {
        up: true, alerts: [], resolutions: [], notifications: [], state: null, seq: 0,
        reset() { Object.assign(this, { up: true, alerts: [], resolutions: [], notifications: [], state: null, seq: 0 }); },
        guard() { if (!this.up) throw new Error('connect ECONNREFUSED'); },
    };
    const open = (type) => s.alerts.find(a => a.alert_type === type && !a.resolved_at);
    return {
        _s: s,
        RESOLVED_BY: 'watchdog (scripts/watchdog.js)',
        probe: async () => { s.guard(); return true; },
        listOpen: async () => { s.guard(); return s.alerts.filter(a => !a.resolved_at); },
        openAlert: async (db, c, since) => {
            s.guard();
            const type = 'watchdog_' + c.condition;
            const existing = open(type);
            if (existing) return { id: existing.id, created: false };
            const a = { id: `a${++s.seq}`, alert_type: type, created_at: since, resolved_at: null,
                details: { condition: c.condition, title: c.title, summary: c.summary } };
            s.alerts.push(a);
            return { id: a.id, created: true };
        },
        resolveAlert: async (db, condition, { resolution, basis }) => {
            s.guard();
            const a = open('watchdog_' + condition);
            if (!a) return [];
            a.resolved_at = new Date();
            s.resolutions.push({ alert_id: a.id, resolution, basis });
            return [a.id];
        },
        recordClosed: async (db, c, { since, clearedAt, resolution }) => {
            s.guard();
            const a = { id: `a${++s.seq}`, alert_type: 'watchdog_' + c.condition, created_at: since, resolved_at: clearedAt,
                details: { recorded_late: true } };
            s.alerts.push(a);
            s.resolutions.push({ alert_id: a.id, resolution });
            return a.id;
        },
        writeState: async (db, st) => { s.guard(); s.state = st; },
        recordNotification: async (db, n) => { s.guard(); s.notifications.push(n); },
        unsettledOpenAlerts: async () => {
            s.guard();
            return s.alerts.filter(a => !a.resolved_at && !s.notifications.some(n => n.alertId === a.id
                && n.kind === 'opened' && ['sent', 'rate_limited', 'not_configured'].includes(n.outcome)));
        },
    };
});

const store = require('../../../src/watchdog/store');
const { readConfig, EMAIL_NOT_CONFIGURED } = require('../../../src/watchdog/config');
const { evaluate, FailedJobsWindow, alertType, conditionOf, ago } = require('../../../src/watchdog/conditions');
const { Notifier, buildMessage, clean, MAX_ATTEMPTS } = require('../../../src/watchdog/notifier');
const { Watchdog } = require('../../../src/watchdog');

const T0 = new Date('2026-09-29T10:00:00Z');
const cfg0 = readConfig({});
const TH = cfg0.thresholds;

/** A healthy /api/health payload; override parts per test. */
function healthy(over = {}) {
    return {
        status: 'healthy', db_connected: true, active_alerts: [],
        redis: { reachable: true },
        worker: { alive: true, last_heartbeat: T0.toISOString(), queues: { ingest: { waiting: 1, active: 0, delayed: 0, failed: 2 } } },
        sources: { registry: 52, seeded: 52, collecting: 10, online: 9 },
        maintenance: {
            tasks: {
                retention: { last_run_at: T0.toISOString(), last_ok_at: T0.toISOString(), last_failed_at: null, last_error: null },
                daily: null, terms: null,
            },
            retention_overdue: { posts: 0, sources: [] },
        },
        jobs: { failed_last_hour: 0 },
        ...over,
    };
}

const names = (r) => r.conditions.map(c => c.condition).sort();
const ev = (probe, o = {}) => evaluate({ httpStatus: 200, fetchError: null, dbReachable: true, ...probe },
    { now: T0, thresholds: TH, ...o });

// ─── config ────────────────────────────────────────────────────────────────
describe('readConfig', () => {
    test('defaults: 2-minute poll, e-mail not configured, no errors', () => {
        expect(cfg0.pollIntervalMs).toBe(120000);
        expect(cfg0.initialDelayMs).toBe(60000);
        expect(cfg0.healthUrl).toBe('http://web:3000/api/health');
        expect(cfg0.smtp).toBeNull();
        expect(cfg0.emailStatus).toBe(EMAIL_NOT_CONFIGURED);
        expect(cfg0.errors).toEqual([]);
    });

    test('bad values fall back to the default and are reported, never thrown', () => {
        const c = readConfig({ WATCHDOG_POLL_INTERVAL_S: '0', WATCHDOG_MAX_QUEUE_DEPTH: '1e3',
            WATCHDOG_HEALTH_URL: 'ftp://x', SMTP_SECURE: 'maybe', SMTP_HOST: 'h', SMTP_FROM: 'a@b.org', SMTP_TO: 'c@d.org' });
        expect(c.pollIntervalMs).toBe(120000);
        expect(c.thresholds.maxQueueDepth).toBe(5000);
        expect(c.healthUrl).toBe('http://web:3000/api/health');
        expect(c.errors).toEqual(expect.arrayContaining([
            expect.stringMatching(/^WATCHDOG_POLL_INTERVAL_S="0" is not a whole number from 15 to 3600; using 120$/),
            expect.stringMatching(/^WATCHDOG_MAX_QUEUE_DEPTH="1e3"/),
            expect.stringMatching(/^WATCHDOG_HEALTH_URL/),
            'SMTP_SECURE must be true or false; using false',
        ]));
    });

    test('full SMTP settings: STARTTLS required by default, recipients split', () => {
        const c = readConfig({ SMTP_HOST: 'smtp.example.org', SMTP_USER: 'u', SMTP_PASSWORD: ' p w ',
            SMTP_FROM: 'Pulse <alerts@example.org>', SMTP_TO: 'ops@example.org, oncall@example.org' });
        expect(c.smtp).toEqual({ host: 'smtp.example.org', port: 587, secure: false, requireTLS: true,
            auth: { user: 'u', pass: ' p w ' }, from: 'Pulse <alerts@example.org>', to: ['ops@example.org', 'oncall@example.org'] });
        expect(c.emailStatus).toBe('configured: 2 recipient(s) via smtp.example.org:587 (STARTTLS required)');
        expect(c.errors).toEqual([]);
    });

    test('SMTP_SECURE=true → implicit TLS on 465; SMTP_REQUIRE_TLS=false allows a plain local relay', () => {
        expect(readConfig({ SMTP_HOST: 'h', SMTP_FROM: 'a@b.org', SMTP_TO: 'c@d.org', SMTP_SECURE: 'true' }).smtp)
            .toMatchObject({ port: 465, secure: true, requireTLS: false, auth: null });
        const plain = readConfig({ SMTP_HOST: 'h', SMTP_PORT: '2525', SMTP_FROM: 'a@b.org', SMTP_TO: 'c@d.org', SMTP_REQUIRE_TLS: 'false' });
        expect(plain.smtp).toMatchObject({ port: 2525, secure: false, requireTLS: false });
        expect(plain.emailStatus).toMatch(/\(TLS not required\)$/);
    });

    test('partial or invalid SMTP → not configured, with the reason; never half-configured', () => {
        const c = readConfig({ SMTP_HOST: 'h', SMTP_PASSWORD: 'secret-value' });
        expect(c.smtp).toBeNull();
        expect(c.emailStatus).toMatch(/^email alerting not configured: SMTP settings incomplete or invalid \(missing SMTP_FROM, SMTP_TO; SMTP_USER and SMTP_PASSWORD must be set together\)$/);
        expect(JSON.stringify(c)).not.toContain('secret-value'.repeat(2));
        expect(c.errors.join(' ')).not.toContain('secret-value');
        const bad = readConfig({ SMTP_HOST: 'h', SMTP_FROM: 'not-an-address', SMTP_TO: 'x@y.org,bad' });
        expect(bad.emailStatus).toMatch(/SMTP_FROM is not an e-mail address; SMTP_TO has 1 invalid address/);
        expect(readConfig({ SMTP_HOST: 'h\r\nX: y', SMTP_FROM: 'a@b.org', SMTP_TO: 'c@d.org' }).smtp).toBeNull();
    });
});

// ─── conditions ────────────────────────────────────────────────────────────
describe('evaluate', () => {
    test('a healthy stack raises nothing and nothing is unknown', () => {
        expect(ev({ health: healthy() })).toEqual({ conditions: [], unknown: [] });
    });

    test('worker down: Valkey answers, no live heartbeat', () => {
        const r = ev({ health: healthy({ worker: { alive: false, last_heartbeat: '2026-09-29T09:50:00Z', queues: {} } }) });
        expect(names(r)).toEqual(['worker_down']);
        expect(r.conditions[0].summary).toBe('last worker heartbeat 10 min ago (2026-09-29T09:50:00Z)');
        const none = ev({ health: healthy({ worker: { alive: false, last_heartbeat: null, queues: {} } }) });
        expect(none.conditions[0].summary).toMatch(/^no worker heartbeat/);
    });

    test('Valkey down: valkey_unreachable, and the worker state is UNKNOWN (not "down")', () => {
        const r = ev({ health: healthy({ redis: { reachable: false }, worker: { alive: false, last_heartbeat: null, queues: null } }) });
        expect(names(r)).toEqual(['valkey_unreachable']);
        expect(r.unknown).toEqual(['worker_down', 'queue_backlog', 'failed_jobs_abnormal']);
    });

    test('web unreachable: only web/db are evaluated, the rest is unknown', () => {
        const r = ev({ health: null, httpStatus: null, fetchError: 'fetch failed (ECONNREFUSED)' });
        expect(names(r)).toEqual(['web_unreachable']);
        expect(r.conditions[0].summary).toBe('GET /api/health failed: fetch failed (ECONNREFUSED)');
        expect(r.unknown).toContain('worker_down');
        expect(r.unknown).not.toContain('web_unreachable');
    });

    test('a 5xx while the database is down names the database, not the web API', () => {
        expect(names(ev({ health: null, httpStatus: 500, dbReachable: false }))).toEqual(['db_unreachable']);
        expect(names(ev({ health: null, httpStatus: 502, dbReachable: true }))).toEqual(['web_unreachable']);
        expect(names(ev({ health: null, httpStatus: null, fetchError: 'timeout', dbReachable: false })))
            .toEqual(['db_unreachable', 'web_unreachable']);
        expect(names(ev({ health: healthy({ db_connected: false }) }))).toEqual(['db_unreachable']);
    });

    test('maintenance: latest run failed, or no success within the limit; a task that never ran is skipped', () => {
        const failed = healthy();
        failed.maintenance.tasks.retention = { last_run_at: T0.toISOString(), last_ok_at: '2026-09-29T09:55:00Z',
            last_failed_at: '2026-09-29T09:59:00Z', last_error: 'retention: RETENTION_DETAIL_DAYS invalid' };
        const r = ev({ health: failed });
        expect(names(r)).toEqual(['maintenance_failing']);
        expect(r.conditions[0].summary).toBe('retention: latest run failed');
        expect(r.conditions[0].details.tasks[0].error).toBe('retention: RETENTION_DETAIL_DAYS invalid');

        const old = healthy();
        old.maintenance.tasks.retention.last_ok_at = '2026-09-29T09:00:00Z';
        old.maintenance.tasks.daily = { last_ok_at: '2026-09-27T09:00:00Z', last_failed_at: null };
        old.maintenance.tasks.terms = { last_ok_at: '2026-09-25T09:00:00Z', last_failed_at: null };
        expect(ev({ health: old }).conditions[0].summary)
            .toBe('retention: no successful run for 60 min; daily: no successful run for 2 days');
    });

    test('retention overdue: posts past the window, or an invalid window setting', () => {
        const h = healthy();
        h.maintenance.retention_overdue = { posts: 12, sources: [{ slug: 'reddit', posts: 12, oldest_collected_at: 'x' }] };
        const r = ev({ health: h });
        expect(names(r)).toEqual(['retention_overdue']);
        expect(r.conditions[0].summary).toBe('12 post(s) in 1 source(s) hold text past the retention window');
        h.maintenance.retention_overdue = { error: 'RETENTION_DETAIL_DAYS must be a whole number' };
        expect(ev({ health: h }).conditions[0].summary).toMatch(/^retention window setting invalid/);
    });

    test('collection failing: sources enabled but none online; a demo-only stack (0 collecting) is fine', () => {
        expect(names(ev({ health: healthy({ sources: { collecting: 5, online: 0 } }) }))).toEqual(['collection_failing']);
        expect(names(ev({ health: healthy({ sources: { collecting: 0, online: 0 } }) }))).toEqual([]);
    });

    test('queue backlog above the limit', () => {
        const r = ev({ health: healthy({ worker: { alive: true, last_heartbeat: T0.toISOString(),
            queues: { ingest: { waiting: 4000, delayed: 1500, failed: 0 }, embed: { waiting: 3, delayed: 0 } } } }) });
        expect(names(r)).toEqual(['queue_backlog']);
        expect(r.conditions[0].summary).toBe('ingest: 5500 waiting/delayed (limit 5000)');
    });

    test('failed jobs: queue failures rising, or failed collection cycles', () => {
        expect(names(ev({ health: healthy() }, { queueFailedRise: 26 }))).toEqual(['failed_jobs_abnormal']);
        expect(names(ev({ health: healthy() }, { queueFailedRise: 25 }))).toEqual([]);
        const r = ev({ health: healthy({ jobs: { failed_last_hour: 4 } }) });
        expect(r.conditions[0].summary).toBe('4 failed collection cycle(s) in the last hour (limit 3)');
    });

    test('FailedJobsWindow: rise within the hour; drops (trimmed history) never count', () => {
        const w = new FailedJobsWindow();
        const t = T0.getTime();
        expect(w.record(t, { a: { failed: 100 } })).toBe(0);
        expect(w.record(t + 60000, { a: { failed: 110 }, b: { failed: 5 } })).toBe(10);
        expect(w.record(t + 120000, { a: { failed: 90 }, b: { failed: 8 } })).toBe(13);
        // An hour later the first rise has left the window.
        expect(w.record(t + 3600000 + 90000, { a: { failed: 90 }, b: { failed: 8 } })).toBe(3);
        expect(w.record(t + 3 * 3600000, null)).toBe(3);   // no counts: unchanged
    });

    test('alert type naming', () => {
        expect(alertType('worker_down')).toBe('watchdog_worker_down');
        expect(conditionOf('watchdog_worker_down')).toBe('worker_down');
        expect(conditionOf('source_stale')).toBeNull();
        expect(ago(-1)).toBe('unknown');
        expect(ago(5 * 86400000)).toBe('5 days');
    });
});

// ─── notifier ──────────────────────────────────────────────────────────────
const SMTP = { host: 'smtp.test', port: 2525, secure: false, requireTLS: false, auth: null,
    from: 'watchdog@pulse.test', to: ['ops@pulse.test', 'oncall@pulse.test'] };
const event = (kind = 'opened', condition = 'worker_down') =>
    ({ kind, condition, title: 'Worker down (heartbeat stale)', summary: 'no heartbeat', at: T0, since: T0 });

describe('Notifier', () => {
    test('buildMessage: subject per transition, no control characters', () => {
        const m = buildMessage({ ...event(), title: 'Worker\r\nBcc: evil@x.org' }, { dashboardUrl: 'http://localhost:3000' });
        expect(m.subject).toBe('[Pulse of AI] CRITICAL: Worker Bcc: evil@x.org');
        expect(m.text).toContain('Dashboard: http://localhost:3000');
        expect(buildMessage(event('cleared')).subject).toBe('[Pulse of AI] CLEARED: Worker down (heartbeat stale)');
        expect(buildMessage(event('cleared')).text).toContain('Open since: 2026-09-29T10:00:00.000Z');
        expect(buildMessage(event(), { suppressed: 3 }).text).toContain('3 earlier notification(s) were suppressed');
        expect(clean(null)).toBe('');
    });

    test('sends to every recipient and records the outcome', async () => {
        const sent = [];
        const outcomes = [];
        const n = new Notifier({ smtp: SMTP, maxPerHour: 5, transport: { sendMail: async (m) => sent.push(m) },
            onOutcome: async (o) => outcomes.push(o.outcome + ':' + o.recipients) });
        n.enqueue(event());
        expect(await n.deliver()).toEqual({ sent: 1, failed: 0, rateLimited: 0, notConfigured: 0 });
        expect(sent[0]).toMatchObject({ from: 'watchdog@pulse.test', to: 'ops@pulse.test, oncall@pulse.test',
            subject: '[Pulse of AI] CRITICAL: Worker down (heartbeat stale)' });
        expect(outcomes).toEqual(['sent:2']);
        expect(await n.deliver()).toEqual({ sent: 0, failed: 0, rateLimited: 0, notConfigured: 0 });   // nothing re-sent
    });

    test('no SMTP: nothing sent, recorded as not_configured', async () => {
        const outcomes = [];
        const n = new Notifier({ smtp: null, maxPerHour: 5, onOutcome: async (o) => outcomes.push(o.outcome) });
        n.enqueue(event());
        expect((await n.deliver()).notConfigured).toBe(1);
        expect(outcomes).toEqual(['not_configured']);
        expect(n.configured).toBe(false);
    });

    test('rate limit: at most maxPerHour e-mails per rolling hour; the next one reports the suppressed count', async () => {
        let now = T0.getTime();
        const sent = [];
        const n = new Notifier({ smtp: SMTP, maxPerHour: 2, now: () => now, transport: { sendMail: async (m) => sent.push(m) } });
        for (let i = 0; i < 4; i++) n.enqueue(event('opened', 'c' + i));
        expect(await n.deliver()).toEqual({ sent: 2, failed: 0, rateLimited: 2, notConfigured: 0 });
        now += 3600000;
        n.enqueue(event('cleared', 'c0'));
        await n.deliver();
        expect(sent).toHaveLength(3);
        expect(sent[2].text).toContain('2 earlier notification(s) were suppressed');
    });

    test('a failed send is retried on later deliveries, up to MAX_ATTEMPTS; the onOutcome log never breaks delivery', async () => {
        let calls = 0;
        const n = new Notifier({ smtp: SMTP, maxPerHour: 100,
            transport: { sendMail: async () => { calls++; throw new Error('connect ECONNREFUSED 127.0.0.1:2525\n'); } },
            onOutcome: async () => { throw new Error('db down'); } });
        n.enqueue(event());
        for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await n.deliver();
        expect(calls).toBe(MAX_ATTEMPTS);
        expect(n.lastError).toBe('connect ECONNREFUSED 127.0.0.1:2525');
        expect(n.pending).toHaveLength(0);
    });
});

// ─── the poll loop: dedupe ─────────────────────────────────────────────────
describe('Watchdog poll loop', () => {
    let health;
    let now;
    let sent;
    let logs;
    const fetchImpl = async () => {
        if (health instanceof Error) throw health;
        if (typeof health === 'number') return { ok: false, status: health, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => health };
    };
    function make(over = {}) {
        const cfg = { ...readConfig({}), smtp: SMTP, emailStatus: 'configured', ...over };
        return new Watchdog({ cfg, db: {}, fetchImpl, now: () => now, log: (m) => logs.push(m),
            transport: { sendMail: async (m) => sent.push(m.subject) } });
    }
    beforeEach(() => {
        store._s.reset();
        health = healthy();
        now = new Date(T0);
        sent = [];
        logs = [];
    });
    const tick = (wd, ms = 120000) => { now = new Date(now.getTime() + ms); return wd.pollOnce(); };

    test('a condition opens ONE alert and ONE e-mail, however many polls see it; clearing resolves it with ONE e-mail', async () => {
        const wd = make();
        await wd.init();
        expect((await tick(wd)).opened).toEqual([]);
        health = healthy({ worker: { alive: false, last_heartbeat: null, queues: {} } });
        expect((await tick(wd)).opened).toEqual(['worker_down']);
        for (let i = 0; i < 5; i++) expect((await tick(wd)).opened).toEqual([]);
        expect(store._s.alerts.filter(a => !a.resolved_at).map(a => a.alert_type)).toEqual(['watchdog_worker_down']);
        expect(sent).toEqual(['[Pulse of AI] CRITICAL: Worker down (heartbeat stale)']);
        expect(store._s.state.openConditions.map(c => c.condition)).toEqual(['worker_down']);

        health = healthy();
        expect((await tick(wd)).cleared).toEqual(['worker_down']);
        await tick(wd);
        expect(sent).toEqual(['[Pulse of AI] CRITICAL: Worker down (heartbeat stale)',
            '[Pulse of AI] CLEARED: Worker down (heartbeat stale)']);
        expect(store._s.alerts.filter(a => !a.resolved_at)).toEqual([]);
        expect(store._s.resolutions).toHaveLength(1);
        expect(store._s.resolutions[0].resolution).toBe('cleared: the watchdog no longer detects "Worker down (heartbeat stale)"');
        expect(store._s.notifications.map(n => `${n.kind}:${n.outcome}:${n.alertId}`)).toEqual(['opened:sent:a1', 'cleared:sent:a1']);
    });

    test('web down: web_unreachable opens and the loop keeps polling; open conditions of unknown state are kept, not cleared', async () => {
        const wd = make();
        await wd.init();
        health = healthy({ worker: { alive: false, last_heartbeat: null, queues: {} } });
        await tick(wd);
        health = new Error('fetch failed');
        const r = await tick(wd);
        expect(r.opened).toEqual(['web_unreachable']);
        expect(r.cleared).toEqual([]);                        // worker_down is unknown now, still open
        expect(r.open.sort()).toEqual(['web_unreachable', 'worker_down']);
        health = 503;
        expect((await tick(wd)).opened).toEqual([]);          // still web_unreachable; no new e-mail
        health = healthy();
        expect((await tick(wd)).cleared.sort()).toEqual(['web_unreachable', 'worker_down']);
        expect(sent.filter(s => s.includes('CRITICAL'))).toHaveLength(2);
        expect(sent.filter(s => s.includes('CLEARED'))).toHaveLength(2);
    });

    test('a restarted watchdog resumes open alerts without e-mailing them again', async () => {
        const wd1 = make();
        await wd1.init();
        health = healthy({ worker: { alive: false, last_heartbeat: null, queues: {} } });
        await tick(wd1);
        expect(sent).toHaveLength(1);
        const wd2 = make();
        await wd2.init();
        expect(logs.some(l => /resumed 1 open condition\(s\): worker_down/.test(l))).toBe(true);
        expect((await tick(wd2)).opened).toEqual([]);
        expect(sent).toHaveLength(1);
        health = healthy();
        expect((await tick(wd2)).cleared).toEqual(['worker_down']);
        expect(sent).toHaveLength(2);
    });

    test('a restart re-sends an "opened" e-mail that was never delivered', async () => {
        store._s.alerts.push({ id: 'old', alert_type: 'watchdog_worker_down', created_at: T0, resolved_at: null,
            details: { summary: 'no heartbeat' } });
        store._s.notifications.push({ alertId: 'old', kind: 'opened', outcome: 'failed' });
        const wd = make();
        await wd.init();
        health = healthy({ worker: { alive: false, last_heartbeat: null, queues: {} } });
        await tick(wd);
        expect(sent).toEqual(['[Pulse of AI] CRITICAL: Worker down (heartbeat stale)']);
        await tick(wd);
        expect(sent).toHaveLength(1);
    });

    test('database down: the watchdog keeps running, e-mails the transitions, and records them once the DB is back', async () => {
        store._s.up = false;
        const wd = make();
        await wd.init();                                      // no throw
        health = 500;                                         // web answers 500 because the DB is down
        const r1 = await tick(wd);
        expect(r1.opened).toEqual(['db_unreachable']);
        expect(r1.dbReachable).toBe(false);
        health = healthy({ worker: { alive: false, last_heartbeat: null, queues: {} } });
        store._s.up = true;
        const r2 = await tick(wd);
        expect(r2.cleared).toEqual(['db_unreachable']);
        expect(r2.opened).toEqual(['worker_down']);
        // db_unreachable was never written while open: recorded now, already resolved.
        const late = store._s.alerts.find(a => a.alert_type === 'watchdog_db_unreachable');
        expect(late.resolved_at).toEqual(now);
        expect(late.created_at).toEqual(new Date(T0.getTime() + 120000));
        expect(store._s.alerts.find(a => a.alert_type === 'watchdog_worker_down').resolved_at).toBeNull();
        expect(sent).toEqual(['[Pulse of AI] CRITICAL: Database unreachable',
            '[Pulse of AI] CRITICAL: Worker down (heartbeat stale)', '[Pulse of AI] CLEARED: Database unreachable']);
    });

    test('no SMTP: dashboard only — alerts written, e-mail recorded as not configured', async () => {
        const wd = make({ smtp: null, emailStatus: EMAIL_NOT_CONFIGURED });
        await wd.init();
        health = healthy({ redis: { reachable: false }, worker: { alive: false, queues: null } });
        await tick(wd);
        expect(sent).toEqual([]);
        expect(store._s.alerts.map(a => a.alert_type)).toEqual(['watchdog_valkey_unreachable']);
        expect(store._s.notifications.map(n => n.outcome)).toEqual(['not_configured']);
        expect(store._s.state).toMatchObject({ emailConfigured: false, emailStatus: EMAIL_NOT_CONFIGURED, healthReachable: true });
    });

    test('run() waits the initial delay, polls, and stops cleanly', async () => {
        const wd = make({ initialDelayMs: 0, pollIntervalMs: 5 });
        const polls = [];
        const orig = wd.pollOnce.bind(wd);
        wd.pollOnce = async () => { const r = await orig(); polls.push(r); if (polls.length === 3) wd.stop(); return r; };
        await wd.run();
        expect(polls).toHaveLength(3);
    });
});
