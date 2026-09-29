// src/workers/logging.js
// Worker-process log lines, always through the secret scrubber (F10-1): an
// error message can carry an upstream URL, a server response or a DB
// driver's text that includes a credential. Every line the worker prints
// goes through here.

'use strict';

const { scrub } = require('../collectors/redact');

function log(message, env = process.env, sink = console.log) {
    sink(scrub(String(message), env));
}

function logError(message, env = process.env, sink = console.error) {
    sink(scrub(String(message), env));
}

module.exports = { log, logError };
