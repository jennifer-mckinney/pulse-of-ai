// tests/unit/pure/scrubbedErrorLogs.test.js
// PR #22 security L3: every error line goes through the secret scrubber
// (src/collectors/redact.js). The DB pool's error handler and the compact.js
// CLI logged err.message raw; so did a few other CLI entry points. This
// test fails on any console.error / console.warn / process.stderr.write in
// src/ or scripts/ that prints an error's message (or the error itself)
// without scrub(), outside the two scrubbing helpers.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../../..');
const HELPERS = new Set(['src/workers/logging.js', 'src/middleware/log-error.js']);

function jsFiles(dir) {
    const out = [];
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...jsFiles(rel));
        else if (e.name.endsWith('.js')) out.push(rel);
    }
    return out;
}

/** The argument text of every call to `callee(` in src (balanced parentheses). */
function callArgs(src, callee) {
    const out = [];
    let i = src.indexOf(callee);
    while (i >= 0) {
        let depth = 0;
        let j = i + callee.length - 1;          // at the "("
        for (; j < src.length; j++) {
            if (src[j] === '(') depth++;
            else if (src[j] === ')' && --depth === 0) break;
        }
        out.push({ at: src.slice(0, i).split('\n').length, args: src.slice(i + callee.length, j) });
        i = src.indexOf(callee, j);
    }
    return out;
}

// An argument that carries an error: `.message`, `.stack`, or a bare err / error / e.
const CARRIES_ERROR = /\.message\b|\.stack\b|^\s*(err|error|e)\s*$|,\s*(err|error|e)\s*$/;

function offenders() {
    const hits = [];
    for (const rel of [...jsFiles('src'), ...jsFiles('scripts')]) {
        if (HELPERS.has(rel)) continue;
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        for (const callee of ['console.error(', 'console.warn(', 'process.stderr.write(']) {
            for (const { at, args } of callArgs(src, callee)) {
                if (CARRIES_ERROR.test(args) && !/scrub\(/.test(args)) hits.push(`${rel}:${at}: ${callee}${args.trim().slice(0, 80)})`);
            }
        }
    }
    return hits;
}

test('the detector flags an unscrubbed error line and passes a scrubbed one', () => {
    expect(CARRIES_ERROR.test("'[db] Unexpected pool error:', err.message")).toBe(true);
    expect(CARRIES_ERROR.test('err')).toBe(true);
    expect(CARRIES_ERROR.test("'✗ failed', e")).toBe(true);
    expect(CARRIES_ERROR.test("'No active data sources found'")).toBe(false);
});

test('no error line in src/ or scripts/ bypasses the scrubber', () => {
    expect(offenders()).toEqual([]);
});

test('the DB pool error handler logs through the scrubber', () => {
    const SECRET = 'pool-secret-password-value-123';
    let handler;
    const sink = jest.fn();
    jest.isolateModules(() => {
        jest.doMock('pg', () => ({ Pool: jest.fn(() => ({ on: (ev, fn) => { if (ev === 'error') handler = fn; } })) }));
        jest.doMock('../../../src/workers/logging', () => ({
            logError: (m) => sink(require('../../../src/collectors/redact').scrub(String(m), { POSTGRES_PASSWORD: SECRET })),
        }));
        require('../../../src/db/connection');
    });
    handler(new Error(`password authentication failed: ${SECRET}`));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatch(/^\[db\] Unexpected pool error: /);
    expect(sink.mock.calls[0][0]).not.toContain(SECRET);
    jest.dontMock('pg');
    jest.dontMock('../../../src/workers/logging');
});
