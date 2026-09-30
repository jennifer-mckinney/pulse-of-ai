// tests/integration/watchdog.test.js
// The external watchdog end to end (PR #22 principal #12): the REAL
// /api/health (served by the app on a local port, with the Valkey client
// injected), the REAL test database, and a FAKE SMTP server (smtp-server on
// 127.0.0.1, nothing leaves the machine — never real e-mail).
//
// Shows: a new condition (worker down) opens ONE critical alert, shows on
// /api/health as a system alert, and sends ONE e-mail; further polls send
// nothing; when the worker returns the alert is resolved with an audited
// alert_resolutions record and ONE "cleared" e-mail goes out. Also: the API
// down is itself a condition and the watchdog keeps polling; with SMTP unset
// /api/health says "email alerting not configured".

'use strict';

const { SMTPServer } = require('smtp-server');
const app = require('../../src/server');
const health = require('../../src/routes/health');
const db = require('../../src/db/connection');
const { dbAll, dbGet } = db;
const { readConfig, EMAIL_NOT_CONFIGURED } = require('../../src/watchdog/config');
const { Watchdog } = require('../../src/watchdog');

/** A fake SMTP server that records every message it accepts. */
function startFakeSmtp() {
    const messages = [];
    const server = new SMTPServer({
        secure: false,
        disabledCommands: ['STARTTLS'],
        authOptional: true,
        allowInsecureAuth: true,
        logger: false,
        onAuth(auth, session, cb) {
            if (auth.username === 'wd' && auth.password === 'fake-smtp-pass') return cb(null, { user: 'wd' });
            return cb(new Error('bad credentials'));
        },
        onData(stream, session, cb) {
            let raw = '';
            stream.on('data', (d) => { raw += d.toString('utf8'); });
            stream.on('end', () => {
                const subject = (raw.match(/^Subject: (.*)$/mi) || [])[1];
                messages.push({ subject, raw, to: session.envelope.rcptTo.map(r => r.address), user: session.user });
                cb();
            });
        },
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, messages, port: server.server.address().port }));
    });
}

let smtp;
let web;
let heartbeat;          // what the injected Valkey client returns for the worker heartbeat
let t;                  // the watchdog's clock

beforeAll(async () => {
    smtp = await startFakeSmtp();
    web = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
});

afterAll(async () => {
    health._setRedisClientForTests(null);
    health._setQueueCountsForTests(null);
    await new Promise((r) => web.close(r));
    await new Promise((r) => smtp.server.close(r));
});

beforeEach(() => {
    smtp.messages.length = 0;
    heartbeat = new Date().toISOString();
    health._setRedisClientForTests({ ping: async () => 'PONG', get: async () => heartbeat });
    health._setQueueCountsForTests(async () => ({}));
    t = new Date();
});

function watchdog(env = {}) {
    const cfg = readConfig({
        WATCHDOG_HEALTH_URL: `http://127.0.0.1:${web.address().port}/api/health`,
        SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_REQUIRE_TLS: 'false',
        SMTP_USER: 'wd', SMTP_PASSWORD: 'fake-smtp-pass',
        SMTP_FROM: 'watchdog@pulse.test', SMTP_TO: 'ops@pulse.test,oncall@pulse.test',
        ...env,
    });
    return new Watchdog({ cfg, db, now: () => t, log: () => {} });
}
const poll = (wd) => { t = new Date(t.getTime() + 1000); return wd.pollOnce(); };

test('worker down → one alert, one e-mail; repeated polls add nothing; recovery → resolved, one "cleared" e-mail', async () => {
    const wd = watchdog();
    await wd.init();
    expect((await poll(wd)).open).toEqual([]);

    heartbeat = null;   // the worker stopped: no heartbeat in Valkey
    const r = await poll(wd);
    expect(r.opened).toEqual(['worker_down']);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].subject).toBe('[Pulse of AI] CRITICAL: Worker down (heartbeat stale)');
    expect(smtp.messages[0].to).toEqual(['ops@pulse.test', 'oncall@pulse.test']);
    expect(smtp.messages[0].user).toBe('wd');
    expect(smtp.messages[0].raw).not.toContain('fake-smtp-pass');

    // The dashboard sees it: a critical SYSTEM alert with its title and summary.
    const h = await (await fetch(`http://127.0.0.1:${web.address().port}/api/health`)).json();
    expect(h.active_alerts).toEqual([expect.objectContaining({
        alert_type: 'watchdog_worker_down', severity: 'critical', system: true,
        title: 'Worker down (heartbeat stale)', summary: expect.stringMatching(/^no worker heartbeat/) })]);
    expect(h.watchdog).toMatchObject({ reporting: true, open: [expect.objectContaining({ condition: 'worker_down' })],
        email: { configured: true, status: expect.stringMatching(/^configured: 2 recipient\(s\) via 127\.0\.0\.1:/),
            last_sent_at: expect.any(String), last_error: null } });

    for (let i = 0; i < 4; i++) expect((await poll(wd)).opened).toEqual([]);
    expect(smtp.messages).toHaveLength(1);
    expect((await dbGet(`SELECT COUNT(*)::int AS n FROM alert_events WHERE source_table = 'watchdog'`)).n).toBe(1);

    heartbeat = new Date().toISOString();   // the worker is back
    expect((await poll(wd)).cleared).toEqual(['worker_down']);
    await poll(wd);
    expect(smtp.messages.map(m => m.subject)).toEqual([
        '[Pulse of AI] CRITICAL: Worker down (heartbeat stale)',
        '[Pulse of AI] CLEARED: Worker down (heartbeat stale)',
    ]);
    const [alert] = await dbAll(
        `SELECT ae.resolved_at, r.resolved_by, r.resolution, r.basis FROM alert_events ae
         JOIN alert_resolutions r ON r.alert_id = ae.id WHERE ae.alert_type = 'watchdog_worker_down'`);
    expect(alert.resolved_at).not.toBeNull();
    expect(alert.resolved_by).toBe('watchdog (scripts/watchdog.js)');
    expect(alert.resolution).toBe('cleared: the watchdog no longer detects "Worker down (heartbeat stale)"');
    expect(alert.basis).toMatchObject({ condition: 'worker_down' });
    expect((await (await fetch(`http://127.0.0.1:${web.address().port}/api/health`)).json()).active_alerts).toEqual([]);
    const log = await dbAll(`SELECT kind, outcome, recipients FROM watchdog_notifications ORDER BY recorded_at`);
    expect(log).toEqual([{ kind: 'opened', outcome: 'sent', recipients: 2 }, { kind: 'cleared', outcome: 'sent', recipients: 2 }]);
    // The e-mail log is append-only.
    await expect(db.dbRun(`DELETE FROM watchdog_notifications`)).rejects.toThrow(/append-only/);
});

test('the database enforces one open alert per condition, whatever runs concurrently', async () => {
    const store = require('../../src/watchdog/store');
    const c = { condition: 'worker_down', title: 'Worker down (heartbeat stale)', summary: 's', details: {} };
    const results = await Promise.all([1, 2, 3, 4].map(() => store.openAlert(db, c)));
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(new Set(results.map(r => r.id)).size).toBe(1);
});

test('the web API down is a condition; the watchdog keeps polling and clears it when the API is back', async () => {
    const wd = watchdog({ WATCHDOG_HEALTH_URL: 'http://127.0.0.1:1/api/health', WATCHDOG_HTTP_TIMEOUT_MS: '2000' });
    await wd.init();
    const r1 = await poll(wd);
    expect(r1.opened).toEqual(['web_unreachable']);
    expect(r1.healthReachable).toBe(false);
    expect((await poll(wd)).opened).toEqual([]);
    wd.cfg.healthUrl = `http://127.0.0.1:${web.address().port}/api/health`;
    expect((await poll(wd)).cleared).toEqual(['web_unreachable']);
    expect(smtp.messages.map(m => m.subject)).toEqual([
        '[Pulse of AI] CRITICAL: Web API unreachable', '[Pulse of AI] CLEARED: Web API unreachable']);
});

test('SMTP unset: dashboard only, and /api/health reports "email alerting not configured"', async () => {
    const before = await (await fetch(`http://127.0.0.1:${web.address().port}/api/health`)).json();
    expect(before.watchdog).toMatchObject({ reporting: false, last_poll_at: null,
        email: { configured: false, status: health.WATCHDOG_NOT_REPORTED } });

    const wd = watchdog({ SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASSWORD: '', SMTP_FROM: '', SMTP_TO: '' });
    await wd.init();
    heartbeat = null;
    expect((await poll(wd)).opened).toEqual(['worker_down']);
    expect(smtp.messages).toHaveLength(0);
    const h = await (await fetch(`http://127.0.0.1:${web.address().port}/api/health`)).json();
    expect(h.watchdog.email).toEqual({ configured: false, status: EMAIL_NOT_CONFIGURED, last_sent_at: null, last_error: null });
    expect(h.active_alerts.map(a => a.alert_type)).toEqual(['watchdog_worker_down']);
    expect((await dbAll(`SELECT outcome FROM watchdog_notifications`)).map(r => r.outcome)).toEqual(['not_configured']);
});

test('the SMTP server down: the e-mail fails, is logged, and is retried on the next poll', async () => {
    const wd = watchdog({ SMTP_PORT: '1' });
    await wd.init();
    heartbeat = null;
    const r = await poll(wd);
    expect(r.email.failed).toBe(1);
    const h = await (await fetch(`http://127.0.0.1:${web.address().port}/api/health`)).json();
    expect(h.watchdog.email.last_error).toMatch(/ECONNREFUSED|connect/i);
    expect((await poll(wd)).email.failed).toBe(1);   // retried, not dropped
    expect((await dbAll(`SELECT outcome FROM watchdog_notifications`)).map(x => x.outcome)).toEqual(['failed', 'failed']);
});

test('health reports failed collection cycles of the last hour (failed_jobs_abnormal input)', async () => {
    for (let i = 0; i < 4; i++) {
        await db.dbRun(`INSERT INTO processing_jobs (triggered_by, status, completed_at) VALUES ('cron', 'failed', NOW())`);
    }
    await db.dbRun(`INSERT INTO processing_jobs (triggered_by, status, started_at, completed_at)
                    VALUES ('cron', 'failed', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours')`);
    const h = await (await fetch(`http://127.0.0.1:${web.address().port}/api/health`)).json();
    expect(h.jobs).toEqual({ failed_last_hour: 4 });
    const wd = watchdog();
    await wd.init();
    expect((await poll(wd)).opened).toEqual(['failed_jobs_abnormal']);
});

// PR #22 integration (alerting × governance × bias-security): every
// maintenance scheduler the worker registers — retention, daily (which runs
// the G2 rolling bias window as a step) and terms — is watched. A task whose
// latest run failed opens maintenance_failing naming it, and a clean run
// clears it, so no scheduler can be added to maintenance.worker.js TASKS
// without the watchdog seeing it.
test('the watchdog watches every maintenance scheduler, including the daily bias_window step', async () => {
    const { processMaintenanceJob, TASKS, defaultSteps } = require('../../src/workers/maintenance.worker');
    expect(Object.keys(TASKS).sort()).toEqual(['daily', 'retention', 'terms']);
    expect(defaultSteps({ task: 'daily' }).map(([name]) => name)).toContain('bias_window');

    const wd = watchdog();
    await wd.init();
    for (const task of Object.keys(TASKS)) {
        const steps = task === 'daily'
            ? [['compaction', async () => 0], ['source_runs', async () => 0],
                ['bias_window', async () => { throw new Error('window query failed'); }]]
            : [[`${task}_step`, async () => { throw new Error('boom'); }]];
        await expect(processMaintenanceJob({ data: { task } }, { steps, logError: () => {} })).rejects.toThrow();
        expect((await poll(wd)).opened).toEqual(['maintenance_failing']);
        const alert = await dbGet(`SELECT details FROM alert_events
                                   WHERE alert_type = 'watchdog_maintenance_failing' AND resolved_at IS NULL`);
        expect(alert.details.summary).toBe(`${task}: latest run failed`);
        if (task === 'daily') expect(JSON.stringify(alert.details)).toMatch(/bias_window: window query failed/);

        // A clean run of the same task clears the condition.
        t = new Date(t.getTime() + 1000);
        await processMaintenanceJob({ data: { task } }, { steps: [['ok', async () => 0]] });
        expect((await poll(wd)).cleared).toEqual(['maintenance_failing']);
    }
});
