// src/collectors/redact.js
// Secret hygiene for everything the collectors write or print (F10-1).
//
// Two layers, applied to every error string before it reaches the database
// (source_collection_state.last_error, source_runs.error,
// processing_jobs.error_details), a log line, or a BullMQ job result:
//
//   redactUrl(url)      a URL with every credential-shaped query parameter
//                       (key, api_key, apikey, api-key, token, access_token,
//                       client_secret, email, sig, signature), URL userinfo
//                       and Telegram's /bot<token> path segment replaced by
//                       REDACTED. http.js builds its error messages with it.
//   scrub(text, env)    defence in depth: every non-empty SECRET env value
//                       (the registry's credential class — keys, tokens,
//                       secrets, passwords, client ids, mailbox logins,
//                       contract feed URLs, dataset paths — plus any
//                       *_KEY / *_TOKEN / *_SECRET / *_PASSWORD, NCBI_EMAIL
//                       and the app's own secrets), raw or URL-encoded, is
//                       replaced by [redacted]; URLs left in the text are
//                       passed through redactUrl. The result is capped.
//
// GET /api/sources never serves an error string at all — only the
// classification (errors.js classifyError: error_kind + http_status).

'use strict';

const SECRET_PARAM_RE = /^(key|api[-_]?key|apikey|token|access[-_]?token|client[-_]?secret|email|sig|signature)$/i;
const SECRET_NAME_RE = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CLIENT_ID)$/;
const APP_SECRETS = Object.freeze([
    'POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'AUDIT_HASH_KEY', 'CORRELATION_SALT', 'PROVENANCE_KEY', 'REFRESH_TOKEN',
    'NCBI_EMAIL',
]);
const URL_IN_TEXT_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const MIN_SECRET_LENGTH = 4;
const MAX_TEXT = 2000;

/**
 * @param {string} url
 * @returns {string} the URL with credentials replaced by REDACTED
 */
function redactUrl(url) {
    let u;
    try {
        u = new URL(String(url));
    } catch {
        return '[unparseable url]';
    }
    if (u.username) u.username = 'REDACTED';
    if (u.password) u.password = 'REDACTED';
    u.pathname = u.pathname.replace(/\/bot[^/]+/gi, '/botREDACTED');
    for (const name of [...new Set([...u.searchParams.keys()])]) {
        if (SECRET_PARAM_RE.test(name)) u.searchParams.set(name, 'REDACTED');
    }
    return u.toString();
}

/** Replace every URL inside free text by its redacted form. */
function redactUrlsIn(text) {
    return String(text).replace(URL_IN_TEXT_RE, (m) => {
        // Trailing punctuation is prose, not part of the URL.
        const trail = (m.match(/[).,;:!?]+$/) || [''])[0];
        return redactUrl(m.slice(0, m.length - trail.length)) + trail;
    });
}

/**
 * Env names whose values are secrets. Registry credentials are resolved
 * lazily (the registry requires nothing from here).
 * @param {object} env
 * @returns {string[]}
 */
function secretEnvNames(env) {
    const { registryEnvVars, envClass } = require('../config/source-registry');
    const names = new Set(APP_SECRETS);
    for (const k of registryEnvVars()) if (envClass(k) === 'credential') names.add(k);
    for (const k of Object.keys(env || {})) if (SECRET_NAME_RE.test(k)) names.add(k);
    return [...names];
}

/** Non-empty secret values of an env, longest first (so no partial overlap survives). */
function secretEnvValues(env = process.env) {
    const values = new Set();
    for (const k of secretEnvNames(env)) {
        const v = env[k];
        if (typeof v !== 'string') continue;
        for (const candidate of [v, v.trim()]) {
            if (candidate.length >= MIN_SECRET_LENGTH) values.add(candidate);
        }
    }
    return [...values].sort((a, b) => b.length - a.length);
}

/** Every form a secret takes in a URL or form body. */
function encodedForms(value) {
    const forms = new Set([value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2)]);
    return [...forms];
}

/**
 * @param {unknown} text
 * @param {object} [env]
 * @returns {string|null} the text with every secret removed (null stays null)
 */
function scrub(text, env = process.env) {
    if (text === null || text === undefined) return null;
    let out = String(text);
    for (const value of secretEnvValues(env)) {
        for (const form of encodedForms(value)) {
            if (form && out.includes(form)) out = out.split(form).join('[redacted]');
        }
    }
    out = redactUrlsIn(out);
    return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT - 1)}…` : out;
}

module.exports = { redactUrl, redactUrlsIn, scrub, secretEnvValues, secretEnvNames, SECRET_PARAM_RE };
