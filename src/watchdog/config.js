// src/watchdog/config.js
// Watchdog settings from the environment (PR #22 principal #12).
//
// The watchdog must keep running whatever the operator typed: a bad value is
// never fatal (a crash-looping watchdog watches nothing). Each bad value is
// replaced by its default and reported in `errors`, which the watchdog logs
// and writes to watchdog_state, so /api/health shows the misconfiguration.
//
// E-mail is optional. It is configured when SMTP_HOST, SMTP_FROM and SMTP_TO
// are all set; anything less means "email alerting not configured" (dashboard
// only). SMTP_USER and SMTP_PASSWORD are optional (an open relay on the local
// network needs neither) but must be set together.

'use strict';

const EMAIL_NOT_CONFIGURED = 'email alerting not configured';

// name → [default, min, max]; whole numbers only.
const INT_SETTINGS = Object.freeze({
    WATCHDOG_POLL_INTERVAL_S:        [120, 15, 3600],
    WATCHDOG_INITIAL_DELAY_S:        [60, 0, 3600],
    WATCHDOG_HTTP_TIMEOUT_MS:        [10000, 1000, 60000],
    WATCHDOG_MAX_QUEUE_DEPTH:        [5000, 1, 10000000],
    WATCHDOG_MAX_QUEUE_FAILED_PER_HOUR: [25, 1, 1000000],
    WATCHDOG_MAX_FAILED_CYCLES_PER_HOUR: [3, 1, 10000],
    WATCHDOG_RETENTION_MAX_AGE_MIN:  [30, 10, 1440],
    WATCHDOG_DAILY_MAX_AGE_H:        [26, 2, 240],
    WATCHDOG_TERMS_MAX_AGE_H:        [192, 24, 2000],
    WATCHDOG_EMAIL_MAX_PER_HOUR:     [12, 1, 1000],
    SMTP_PORT:                       [587, 1, 65535],
});

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

function intSetting(env, name, errors) {
    const [def, min, max] = INT_SETTINGS[name];
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return def;
    const s = String(raw).trim();
    const n = /^\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
        errors.push(`${name}=${JSON.stringify(s).slice(0, 40)} is not a whole number from ${min} to ${max}; using ${def}`);
        return def;
    }
    return n;
}

function boolSetting(env, name, def, errors) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return def;
    const s = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes'].includes(s)) return true;
    if (['false', '0', 'no'].includes(s)) return false;
    errors.push(`${name} must be true or false; using ${def}`);
    return def;
}

const str = (env, k) => (env[k] === undefined ? '' : String(env[k]).trim());

/**
 * The SMTP settings, or null with the reason e-mail is off.
 * @returns {{ smtp: object|null, emailStatus: string }}
 */
function smtpConfig(env, errors) {
    const host = str(env, 'SMTP_HOST');
    const from = str(env, 'SMTP_FROM');
    const toRaw = str(env, 'SMTP_TO');
    const user = str(env, 'SMTP_USER');
    // The password is used verbatim (spaces can be part of it).
    const password = env.SMTP_PASSWORD === undefined ? '' : String(env.SMTP_PASSWORD);
    const anySet = host || from || toRaw || user || password;
    if (!anySet) return { smtp: null, emailStatus: EMAIL_NOT_CONFIGURED };

    const missing = [['SMTP_HOST', host], ['SMTP_FROM', from], ['SMTP_TO', toRaw]].filter(([, v]) => !v).map(([k]) => k);
    const to = toRaw.split(',').map(s => s.trim()).filter(Boolean);
    const problems = [];
    if (missing.length) problems.push(`missing ${missing.join(', ')}`);
    if (from && !EMAIL_RE.test(from.replace(/^.*<([^>]+)>\s*$/, '$1'))) problems.push('SMTP_FROM is not an e-mail address');
    const badTo = to.filter(a => !EMAIL_RE.test(a));
    if (badTo.length) problems.push(`SMTP_TO has ${badTo.length} invalid address(es)`);
    if (Boolean(user) !== Boolean(password)) problems.push('SMTP_USER and SMTP_PASSWORD must be set together');
    if (/[\r\n]/.test(host + from + toRaw + user)) problems.push('SMTP settings must not contain line breaks');
    if (problems.length) {
        const msg = `SMTP settings incomplete or invalid (${problems.join('; ')})`;
        errors.push(msg);
        return { smtp: null, emailStatus: `${EMAIL_NOT_CONFIGURED}: ${msg}` };
    }
    const secure = boolSetting(env, 'SMTP_SECURE', false, errors);
    const smtp = {
        host,
        // Unset: the standard port for the mode (465 implicit TLS, 587 submission).
        port: str(env, 'SMTP_PORT') ? intSetting(env, 'SMTP_PORT', errors) : (secure ? 465 : 587),
        // true: TLS from the first byte (port 465). false: STARTTLS, which is
        // REQUIRED unless SMTP_REQUIRE_TLS=false (a local relay or a test
        // server) — credentials never cross the network in clear by default.
        secure,
        requireTLS: secure ? false : boolSetting(env, 'SMTP_REQUIRE_TLS', true, errors),
        auth: user ? { user, pass: password } : null,
        from,
        to,
    };
    return {
        smtp,
        emailStatus: `configured: ${to.length} recipient(s) via ${host}:${smtp.port}`
            + (secure ? ' (TLS)' : smtp.requireTLS ? ' (STARTTLS required)' : ' (TLS not required)'),
    };
}

/**
 * @param {object} [env]
 * @returns {object} the watchdog configuration; never throws
 */
function readConfig(env = process.env) {
    const errors = [];
    const n = (k) => intSetting(env, k, errors);
    const healthUrl = str(env, 'WATCHDOG_HEALTH_URL') || 'http://web:3000/api/health';
    let url = healthUrl;
    try {
        const u = new URL(healthUrl);
        if (!/^https?:$/.test(u.protocol)) throw new Error('protocol');
    } catch {
        errors.push('WATCHDOG_HEALTH_URL is not an http(s) URL; using http://web:3000/api/health');
        url = 'http://web:3000/api/health';
    }
    const { smtp, emailStatus } = smtpConfig(env, errors);
    const publicUrl = str(env, 'WATCHDOG_DASHBOARD_URL');
    return {
        pollIntervalMs: n('WATCHDOG_POLL_INTERVAL_S') * 1000,
        initialDelayMs: n('WATCHDOG_INITIAL_DELAY_S') * 1000,
        httpTimeoutMs: n('WATCHDOG_HTTP_TIMEOUT_MS'),
        healthUrl: url,
        dashboardUrl: /^https?:\/\/[^\s]+$/.test(publicUrl) ? publicUrl : '',
        thresholds: {
            maxQueueDepth: n('WATCHDOG_MAX_QUEUE_DEPTH'),
            maxQueueFailedPerHour: n('WATCHDOG_MAX_QUEUE_FAILED_PER_HOUR'),
            maxFailedCyclesPerHour: n('WATCHDOG_MAX_FAILED_CYCLES_PER_HOUR'),
            retentionMaxAgeMs: n('WATCHDOG_RETENTION_MAX_AGE_MIN') * 60000,
            dailyMaxAgeMs: n('WATCHDOG_DAILY_MAX_AGE_H') * 3600000,
            termsMaxAgeMs: n('WATCHDOG_TERMS_MAX_AGE_H') * 3600000,
        },
        emailMaxPerHour: n('WATCHDOG_EMAIL_MAX_PER_HOUR'),
        smtp,
        emailStatus,
        errors,
    };
}

module.exports = { readConfig, EMAIL_NOT_CONFIGURED, INT_SETTINGS };
