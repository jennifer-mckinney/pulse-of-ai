// src/workers/logging.js
// Worker-process log lines, always through the secret scrubber (F10-1): an
// error message can carry an upstream URL, a server response or a DB
// driver's text that includes a credential. Every line the worker prints
// goes through here. PR #22 security L4: upstream text is as untrusted as
// request data, so control characters are escaped too (one message, one
// log line; src/middleware/log-error.js neutralizeControl).

'use strict';

const { scrub } = require('../collectors/redact');
const { neutralizeControl } = require('../middleware/log-error');

function log(message, env = process.env, sink = console.log) {
    sink(scrub(neutralizeControl(String(message)), env));
}

function logError(message, env = process.env, sink = console.error) {
    sink(scrub(neutralizeControl(String(message)), env));
}

module.exports = { log, logError };
