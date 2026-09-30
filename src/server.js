// src/server.js
// Express application entry point.
//
// Exports the `app` object for supertest integration tests.
// Starts the HTTP server only when executed directly (not when imported by tests).
//
// Route modules mount under /api:
//   GET  /api/health
//   GET  /api/posts/aggregated-by-location
//   GET  /api/sentiment/latest
//   POST /api/refresh
//   GET  /api/audit/:post_id
//   GET  /api/bias/latest
//   GET  /api/bias/history
//   GET  /api/methodology
//   GET  /api/sources
//   GET  /api/sources/timeseries
//   POST /api/query
//   GET  /api/themes

'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');
const cors    = require('cors');

const healthRouter      = require('./routes/health');
const postsRouter       = require('./routes/posts');
const sentimentRouter   = require('./routes/sentiment');
const refreshRouter     = require('./routes/refresh');
const auditRouter       = require('./routes/audit');
const biasRouter        = require('./routes/bias');
const methodologyRouter = require('./routes/methodology');
const sourcesRouter     = require('./routes/sources');
const queryRouter       = require('./routes/query');
const themesRouter      = require('./routes/themes');
const { logRouteError } = require('./middleware/log-error');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Global middleware ────────────────────────────────────────────────────────

// Security headers — set on EVERY response (static assets included), so this
// runs before express.static. The CSP is deliberately strict: the frontend is
// fully self-hosted (FR-25 — vendored fonts/world-atlas, no CDN, no inline
// scripts or style attributes), so no 'unsafe-inline' anywhere.
const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
    res.set({
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options':  'nosniff',
        'X-Frame-Options':         'DENY',
        'Referrer-Policy':         'no-referrer',
    });
    next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── API routes ───────────────────────────────────────────────────────────────
// F2: CORS is scoped to the READ-ONLY surface only. POST /api/refresh mutates
// state (creates a processing job), so it is mounted FIRST and without cors().
// Withholding CORS headers only hides the response — a simple cross-site POST
// is still sent — so the route itself rejects cross-site POSTs with 403
// (src/middleware/same-origin.js), and its OPTIONS preflight is answered
// inside refreshRouter with a 403 (no CORS headers) so it never falls through
// to readOnlyApi's cors(). Everything below serves read-only data (POST
// /api/query is a read-only search) and stays world-readable.
app.use('/api', refreshRouter);

const readOnlyApi = express.Router();
readOnlyApi.use(cors());
readOnlyApi.use(healthRouter);
readOnlyApi.use(postsRouter);
readOnlyApi.use(sentimentRouter);
readOnlyApi.use(auditRouter);
readOnlyApi.use(biasRouter);
readOnlyApi.use(methodologyRouter);
readOnlyApi.use(sourcesRouter);
readOnlyApi.use(queryRouter);
readOnlyApi.use(themesRouter);
app.use('/api', readOnlyApi);

// ─── Frontend fallback ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Error handler (security audit, 2026-09-29) ──────────────────────────────
// Express's default handler answers a malformed JSON body (POST /api/query,
// POST /api/refresh) with an HTML page carrying the stack trace and absolute
// file paths whenever NODE_ENV is not production. Every error that reaches
// here is answered as JSON with a generic message — never a stack, path or
// upstream text, in any environment — and logged server-side, scrubbed.
// eslint-disable-next-line no-unused-vars -- Express needs the 4-arity signature
function jsonErrorHandler(err, req, res, next) {
    const parseFailed = err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err));
    const status = parseFailed ? 400
        : (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500);
    logRouteError(parseFailed ? 'request' : 'server', err);
    if (res.headersSent) return next(err);
    const error = parseFailed ? 'invalid JSON body'
        : status === 413 ? 'request body too large'
            : status < 500 ? 'bad request' : 'Internal server error';
    return res.status(status).json({ error });
}
app.use(jsonErrorHandler);

// ─── Listening address (dev bind gap) ────────────────────────────────────────
// Bare `npm run dev` listened on every interface while refresh treated it
// as loopback, so REFRESH_TOKEN was never required. The server now binds
// 127.0.0.1 unless HOST or PULSE_BIND_ADDR says otherwise, and the refresh
// guard reads the ACTUAL bound address (app.locals.boundAddress, set on
// listen). In the compose web container the process listens on 0.0.0.0 behind
// Docker's port publish; PULSE_CONTAINER_PUBLISHED_ADDR (set by compose to
// the published PULSE_BIND_ADDR) is then what decides exposure.
function listenHost(env = process.env) {
    for (const k of ['HOST', 'PULSE_BIND_ADDR']) {
        const v = typeof env[k] === 'string' ? env[k].trim() : '';
        if (v) return v;
    }
    return '127.0.0.1';
}

/** Start listening; resolves the http.Server once bound. */
function start({ port = PORT, host = listenHost(), log = console.log } = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            const addr = server.address();
            app.locals.boundAddress = addr && typeof addr === 'object' ? addr.address : host;
            log(`Pulse of AI server listening on ${host}:${addr && addr.port}`);
            resolve(server);
        });
        server.on('error', reject);
    });
}

// ─── Start server only when run directly ─────────────────────────────────────
/* istanbul ignore next -- process entry point; start() is tested directly */
if (require.main === module) {
    start().catch((err) => { logRouteError('server', err); process.exit(1); });
}

module.exports = app;
module.exports.start = start;
module.exports.listenHost = listenHost;
module.exports.jsonErrorHandler = jsonErrorHandler;
