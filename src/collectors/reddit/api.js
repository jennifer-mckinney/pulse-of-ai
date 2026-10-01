// src/collectors/reddit/api.js
// The one Reddit Data API client (collection, discovery, deletion re-check).
//
//   Token: application-only OAuth, grant_type=client_credentials, HTTP Basic
//     auth (client id : secret) POSTed to https://www.reddit.com/api/v1/
//     access_token (research §1.2). The bearer token is cached IN MEMORY per
//     client id until shortly before it expires; it is never written to the
//     database, a cursor or a log. The secret travels only in that request's
//     Authorization header (a credentialed request: no cross-origin redirect
//     is ever followed, src/collectors/http.js).
//   Calls: GET https://oauth.reddit.com<path>?…&raw_json=1 with
//     "Authorization: bearer <token>" and Reddit's required User-Agent
//     (REDDIT_USER_AGENT, "<platform>:<app id>:<version> (by /u/<name>)" —
//     the collector User-Agent is not Reddit's format, research §1.2).
//   Hosts: the token call may reach www.reddit.com only; API calls
//     oauth.reddit.com only (every hop is checked, src/collectors/netguard.js).
//     No reddit.com page, .json or .rss endpoint is ever requested.
//   Budget: every request (the token included) takes one grant from the
//     shared budget (./budget.js) first; X-Ratelimit-* headers are fed back.
//   A 401 on an API call drops the cached token and retries ONCE with a new
//     token; any other refusal (401 on the token, 403, 451) is the source
//     saying no and propagates (the runner's refused state, F10-5).

'use strict';

const crypto = require('crypto');
const { AccessDeniedError, GateClosedError } = require('../errors');
const { BudgetExhaustedError } = require('./budget');

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const TOKEN_HOST = 'www.reddit.com';
const API_ORIGIN = 'https://oauth.reddit.com';
const API_HOST = 'oauth.reddit.com';
const REFRESH_EARLY_MS = 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;
const INFO_BATCH = 100;

// Reddit's format: <platform>:<app ID>:<version string> (by /u/<reddit username>)
const USER_AGENT_RE = /^[A-Za-z0-9._-]{1,40}:[A-Za-z0-9._-]{1,80}:[A-Za-z0-9._-]{1,40} \(by \/u\/[A-Za-z0-9_-]{3,20}\)$/;

// client-id hash → { token, expiresAt }. Process memory only.
const TOKENS = new Map();

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const cacheKey = (clientId) => crypto.createHash('sha256').update(clientId).digest('hex');

/** Drop every cached token (tests; revocation). */
function clearTokenCache() {
    TOKENS.clear();
}

/**
 * REDDIT_USER_AGENT, checked against Reddit's required format.
 * @throws {GateClosedError} when it is missing or malformed (never sent)
 */
function redditUserAgent(env) {
    const ua = trimmed(env.REDDIT_USER_AGENT);
    if (!USER_AGENT_RE.test(ua)) {
        throw new GateClosedError('REDDIT_USER_AGENT must follow Reddit\'s format '
            + '"<platform>:<app id>:<version> (by /u/<reddit username>)" — refusing to call the API');
    }
    return ua;
}

class RedditApi {
    /**
     * @param {object} o
     * @param {import('../http').HttpClient} o.http
     * @param {object} o.env
     * @param {{ take: Function, observe: Function }} o.budget
     * @param {(extra: object) => object} [o.requestOptions]  the collector's request options
     * @param {number} [o.reserve]  budget reserve (background jobs)
     * @param {Function} [o.now]
     */
    constructor({ http, env, budget, requestOptions = (x) => x, reserve = 0, now = () => Date.now() }) {
        this.http = http;
        this.env = env;
        this.budget = budget;
        this.requestOptions = requestOptions;
        this.reserve = reserve;
        this.now = now;
        this.clientId = trimmed(env.REDDIT_CLIENT_ID);
        this.secret = trimmed(env.REDDIT_CLIENT_SECRET);
        if (!this.clientId || !this.secret) throw new GateClosedError('Reddit OAuth client id and secret are required');
        this.userAgent = redditUserAgent(env);
        this.requests = 0;
    }

    async grant() {
        if (!(await this.budget.take({ reserve: this.reserve }))) throw new BudgetExhaustedError();
        this.requests++;
    }

    /**
     * Diagnosis 2026-10-01 (grumpy #1 / #2): a host backing off after a rate
     * limit is not asked — and no budget is spent nor a token fetched for a
     * request that would only be refused unsent (RateLimitedError { held }).
     */
    assertNotHeld(host, url) {
        const held = typeof this.http.heldError === 'function' ? this.http.heldError(host, url) : null;
        if (held) throw held;
    }

    /** The cached bearer token, or a new one. */
    async token() {
        const key = cacheKey(this.clientId);
        const hit = TOKENS.get(key);
        // Copilot review: the token host is a PREREQUISITE of the route
        // (rate-limit.js mode 'any') — held, it holds the API too, even with
        // a cached token.
        this.assertNotHeld(TOKEN_HOST, TOKEN_URL);
        if (hit && hit.expiresAt - REFRESH_EARLY_MS > this.now()) return hit.token;
        await this.grant();
        const basic = Buffer.from(`${this.clientId}:${this.secret}`).toString('base64');
        const res = await this.http.json(TOKEN_URL, this.requestOptions({
            allowedHosts: [TOKEN_HOST],
            method: 'POST',
            headers: {
                Authorization: `Basic ${basic}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': this.userAgent,
            },
            body: 'grant_type=client_credentials',
        }));
        await this.budget.observe(res.headers);
        const d = res.data && typeof res.data === 'object' ? res.data : {};
        if (typeof d.access_token !== 'string' || d.access_token === '' || String(d.token_type || '').toLowerCase() !== 'bearer') {
            // Reddit answers some credential errors with 200 + {"error": …}.
            // The body is never quoted (F10-13).
            throw new AccessDeniedError('www.reddit.com refused the client-credentials token request (no bearer token issued)',
                { status: res.status || null });
        }
        const ttl = Number(d.expires_in) > 0 ? Number(d.expires_in) * 1000 : DEFAULT_TOKEN_TTL_MS;
        TOKENS.set(key, { token: d.access_token, expiresAt: this.now() + ttl });
        return d.access_token;
    }

    /**
     * GET an API path (always with raw_json=1).
     * @param {string} path   e.g. /r/MachineLearning/new
     * @param {object} [params]
     * @returns {Promise<object>} parsed JSON
     */
    async get(path, params = {}, retried = false) {
        if (!/^\/[A-Za-z0-9_/.-]*$/.test(path)) throw new Error(`invalid Reddit API path ${JSON.stringify(path).slice(0, 80)}`);
        this.assertNotHeld(API_HOST, `${API_ORIGIN}${path}`);
        const token = await this.token();
        await this.grant();
        const q = new URLSearchParams({ ...params, raw_json: '1' });
        let res;
        try {
            res = await this.http.json(`${API_ORIGIN}${path}?${q}`, this.requestOptions({
                allowedHosts: [API_HOST],
                headers: { Authorization: `bearer ${token}`, 'User-Agent': this.userAgent },
            }));
        } catch (err) {
            if (err && err.status === 401 && !retried) {
                TOKENS.delete(cacheKey(this.clientId));
                return this.get(path, params, true);
            }
            throw err;
        }
        await this.budget.observe(res.headers);
        return res.data;
    }

    /** A listing: { children: [{ kind, data }], after: string|null }. */
    async listing(path, params = {}) {
        const body = await this.get(path, params);
        const data = body && body.kind === 'Listing' && body.data && typeof body.data === 'object' ? body.data : {};
        return {
            children: Array.isArray(data.children) ? data.children : [],
            after: typeof data.after === 'string' && data.after ? data.after : null,
        };
    }

    /** /r/{sub}/about → its data object (or null). */
    async about(subreddit) {
        const body = await this.get(`/r/${encodeURIComponent(subreddit)}/about`);
        return body && body.kind === 't5' && body.data && typeof body.data === 'object' ? body.data : null;
    }

    /** /api/info for up to 100 fullnames → the things Reddit still returns. */
    async info(fullnames) {
        if (fullnames.length === 0) return [];
        if (fullnames.length > INFO_BATCH) throw new Error(`/api/info takes at most ${INFO_BATCH} fullnames`);
        const { children } = await this.listing('/api/info', { id: fullnames.join(',') });
        return children;
    }
}

module.exports = {
    RedditApi, redditUserAgent, clearTokenCache, TOKEN_URL, API_ORIGIN, API_HOST, TOKEN_HOST, USER_AGENT_RE,
    INFO_BATCH, REFRESH_EARLY_MS,
};
