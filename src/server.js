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
// state (creates a processing job), so it is mounted FIRST and without cors()
// — cross-origin pages get no Access-Control-Allow-Origin for it, while the
// same-origin frontend is unaffected. Everything below serves read-only data
// (POST /api/query is a read-only search) and stays world-readable.
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

// ─── Start server only when run directly ─────────────────────────────────────
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Pulse of AI server running on http://localhost:${PORT}`);
        console.log(`Dashboard available at http://localhost:${PORT}`);
    });
}

module.exports = app;
