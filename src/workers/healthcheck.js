#!/usr/bin/env node
// src/workers/healthcheck.js — the worker container's HEALTHCHECK (P9-7).
// Exit 0 when the heartbeat file (written after every successful Redis
// heartbeat, src/workers/heartbeat.js) is fresh, 1 otherwise.

'use strict';

const { fileIsFresh, HEARTBEAT_FILE, HEALTHCHECK_MAX_AGE_MS } = require('./heartbeat');

/* istanbul ignore next -- process entry point; fileIsFresh is unit-tested */
process.exit(fileIsFresh(HEARTBEAT_FILE, HEALTHCHECK_MAX_AGE_MS) ? 0 : 1);
