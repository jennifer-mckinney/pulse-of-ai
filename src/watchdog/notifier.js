// src/watchdog/notifier.js
// E-mail delivery for the watchdog (PR #22 principal #12).
//
// One e-mail per condition OPENED and one per condition CLEARED — never one
// per poll: the watchdog calls notify() only on a transition. On top of that:
//   - rate limit: at most WATCHDOG_EMAIL_MAX_PER_HOUR e-mails in any rolling
//     hour (a flapping condition cannot flood the inbox); a suppressed e-mail
//     is recorded as 'rate_limited' and counted in the next one that goes out;
//   - retry: a failed send (SMTP down) is retried on later polls, up to
//     MAX_ATTEMPTS, then recorded as failed for good;
//   - no SMTP configured: nothing is sent, the decision is recorded as
//     'not_configured' (the dashboard still shows the alert).
// Every outcome is passed to onOutcome (the watchdog writes it to the
// append-only watchdog_notifications table).
//
// The transport is nodemailer's SMTP transport, created lazily; tests inject
// a fake transport or point it at a local fake SMTP server. Messages carry no
// secret: condition, summary, time, and the dashboard URL when configured.

'use strict';

const { scrub } = require('../collectors/redact');

const MAX_ATTEMPTS = 5;
const HOUR_MS = 3600000;

/**
 * Scrub secrets, strip control characters (header / log injection) and bound
 * the length. PR #22 integration (security L3 × principal #12): every text
 * the watchdog logs, stores in watchdog_state (served by /api/health) or
 * e-mails goes through the shared secret scrubber first, so an SMTP or
 * database error that echoes SMTP_PASSWORD / POSTGRES_PASSWORD, or a URL
 * with a credential, never leaves the process.
 */
function clean(s, max = 500) {
    const scrubbed = scrub(s === undefined || s === null ? '' : s);
    return String(scrubbed === null ? '' : scrubbed).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/**
 * @param {{ kind: 'opened'|'cleared', condition: string, title: string, summary: string, at: Date, since?: Date|null }} ev
 * @param {{ dashboardUrl?: string, suppressed?: number }} [o]
 * @returns {{ subject: string, text: string }}
 */
function buildMessage(ev, { dashboardUrl = '', suppressed = 0 } = {}) {
    const title = clean(ev.title, 120);
    const subject = ev.kind === 'opened'
        ? `[Pulse of AI] CRITICAL: ${title}`
        : `[Pulse of AI] CLEARED: ${title}`;
    const lines = [
        ev.kind === 'opened'
            ? `The Pulse of AI watchdog detected a critical problem: ${title}.`
            : `The Pulse of AI watchdog reports that this condition has CLEARED: ${title}.`,
        '',
        `Condition: ${clean(ev.condition, 60)}`,
        `Detail:    ${clean(ev.summary)}`,
        `${ev.kind === 'opened' ? 'Detected' : 'Cleared'}:  ${ev.at.toISOString()}`,
    ];
    if (ev.kind === 'cleared' && ev.since) lines.push(`Open since: ${ev.since.toISOString()}`);
    if (dashboardUrl) lines.push(`Dashboard: ${clean(dashboardUrl, 300)} (health chip, top right)`);
    if (suppressed > 0) {
        lines.push('', `${suppressed} earlier notification(s) were suppressed by the e-mail rate limit; `
            + 'the dashboard lists every open alert.');
    }
    lines.push('', 'You receive one e-mail when a condition opens and one when it clears.',
        'Sent by the watchdog service (scripts/watchdog.js).');
    return { subject: clean(subject, 200), text: lines.join('\n') };
}

/* istanbul ignore next -- real nodemailer transport; tests inject one */
function defaultTransport(smtp) {
    const nodemailer = require('nodemailer');
    return nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        requireTLS: smtp.requireTLS,
        auth: smtp.auth || undefined,
        tls: { rejectUnauthorized: true },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
    });
}

class Notifier {
    /**
     * @param {{ smtp: object|null, maxPerHour: number, dashboardUrl?: string,
     *           transport?: { sendMail: Function }, onOutcome?: Function, now?: () => number }} o
     */
    constructor({ smtp, maxPerHour, dashboardUrl = '', transport = null, onOutcome = async () => {}, now = () => Date.now() }) {
        this.smtp = smtp;
        this.maxPerHour = maxPerHour;
        this.dashboardUrl = dashboardUrl;
        this.transport = transport;
        this.onOutcome = onOutcome;
        this.now = now;
        this.sentAt = [];        // send times within the last hour (rate limit)
        this.pending = [];       // [{ ev, attempts }] awaiting a (re)try
        this.suppressed = 0;
        this.lastSentAt = null;
        this.lastError = null;
    }

    get configured() { return Boolean(this.smtp); }

    /** Queue one transition e-mail; deliver() sends it. */
    enqueue(ev) {
        this.pending.push({ ev, attempts: 0 });
    }

    _transport() {
        if (!this.transport) this.transport = defaultTransport(this.smtp);
        return this.transport;
    }

    async _record(ev, outcome, error = null) {
        try {
            await this.onOutcome({ ev, outcome, recipients: outcome === 'sent' ? this.smtp.to.length : 0, error });
        } catch { /* the log is best effort; the e-mail decision stands */ }
    }

    /**
     * Try every pending e-mail once. Never throws.
     * @returns {Promise<{ sent: number, failed: number, rateLimited: number, notConfigured: number }>}
     */
    async deliver() {
        const res = { sent: 0, failed: 0, rateLimited: 0, notConfigured: 0 };
        const queue = this.pending;
        this.pending = [];
        for (const item of queue) {
            const { ev } = item;
            if (!this.smtp) {
                res.notConfigured++;
                await this._record(ev, 'not_configured');
                continue;
            }
            const now = this.now();
            this.sentAt = this.sentAt.filter(t => now - t < HOUR_MS);
            if (this.sentAt.length >= this.maxPerHour) {
                res.rateLimited++;
                this.suppressed++;
                await this._record(ev, 'rate_limited', `more than ${this.maxPerHour} e-mails in an hour`);
                continue;
            }
            const { subject, text } = buildMessage(ev, { dashboardUrl: this.dashboardUrl, suppressed: this.suppressed });
            try {
                item.attempts++;
                await this._transport().sendMail({ from: this.smtp.from, to: this.smtp.to.join(', '), subject, text });
                this.sentAt.push(now);
                this.suppressed = 0;
                this.lastSentAt = new Date(now);
                this.lastError = null;
                res.sent++;
                await this._record(ev, 'sent');
            } catch (err) {
                // The SMTP error text can echo the server's reply; never the password.
                const msg = clean(err && err.message, 300);
                this.lastError = msg;
                res.failed++;
                await this._record(ev, 'failed', `attempt ${item.attempts}/${MAX_ATTEMPTS}: ${msg}`);
                if (item.attempts < MAX_ATTEMPTS) this.pending.push(item);
            }
        }
        return res;
    }
}

module.exports = { Notifier, buildMessage, clean, MAX_ATTEMPTS };
