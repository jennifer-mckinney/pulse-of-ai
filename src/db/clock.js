// src/db/clock.js
// ONE database timestamp per request for routes that build time windows.
//
// PR #8 review: routes that ran several window queries each evaluated NOW()
// on their own (every pool query is its own transaction, so NOW() differs
// per query). When an hour boundary fell between them, the counts and the
// metadata could describe different windows. A route now reads its anchor
// ONCE through this module and passes it to every query as a parameter.
// The database clock is used, never the app clock, so the window cannot
// drift from the stored timestamps it filters.
//
// Routes call these through the module object (clock.dbNow()), not a
// destructured copy, so tests can pin the anchor with jest.spyOn and prove
// that every query honours it.

'use strict';

const connection = require('./connection');

/**
 * The database's NOW() as a Date, rounded UP to the millisecond.
 *
 * PostgreSQL timestamps have microsecond precision but a JS Date has
 * millisecond precision: a plain NOW() came back truncated, so a row stored
 * earlier in the same millisecond (created_at = …123456 µs) fell AFTER the
 * anchor (…123 ms) and was left out of a `created_at <= anchor` window
 * (a flaky GET /api/bias/history in CI). Rounding up keeps the anchor at
 * or after every row already stored, and is exactly representable.
 */
async function dbNow() {
    const row = await connection.dbGet(
        `SELECT date_trunc('milliseconds', NOW())
                + CASE WHEN NOW() = date_trunc('milliseconds', NOW()) THEN INTERVAL '0' ELSE INTERVAL '1 millisecond' END
                AS now`,
    );
    return row.now;
}

/** date_trunc('hour', NOW()): the start of the current clock hour, as a Date. */
async function hourAnchor() {
    const row = await connection.dbGet(`SELECT date_trunc('hour', NOW()) AS anchor`);
    return row.anchor;
}

module.exports = { dbNow, hourAnchor };
