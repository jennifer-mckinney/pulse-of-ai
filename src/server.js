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
//   GET  /api/methodology
//   GET  /api/sources
//   POST /api/query

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

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Global middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api', healthRouter);
app.use('/api', postsRouter);
app.use('/api', sentimentRouter);
app.use('/api', refreshRouter);
app.use('/api', auditRouter);
app.use('/api', biasRouter);
app.use('/api', methodologyRouter);
app.use('/api', sourcesRouter);
app.use('/api', queryRouter);

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
