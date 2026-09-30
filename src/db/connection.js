// src/db/connection.js
// PostgreSQL connection pool and Promise-based query helpers.
// All application code uses dbAll/dbGet/dbRun — never the pool directly.
// This abstraction means the pool configuration is in one place and
// tests can mock these helpers without touching pg internals.

'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const isTest = process.env.NODE_ENV === 'test';
const msEnv = (k, d) => { const n = parseInt(process.env[k] || '', 10); return Number.isFinite(n) && n > 0 ? n : d; };

const pool = new Pool({
    host:     process.env.POSTGRES_HOST     || 'localhost',
    port:     isTest
                ? (parseInt(process.env.POSTGRES_TEST_PORT, 10) || 5433)
                : (parseInt(process.env.POSTGRES_PORT, 10)      || 5432),
    database: isTest
                ? (process.env.POSTGRES_TEST_DB || 'pulse_of_ai_test')
                : (process.env.POSTGRES_DB       || 'pulse_of_ai'),
    user:     process.env.POSTGRES_USER     || 'pulse_user',
    password: process.env.POSTGRES_PASSWORD,
    // P10-12: configurable (PG_POOL_MAX). Web default 10; the worker sizes
    // its pool against its job concurrency (src/db/pool-size.js).
    max:      (() => { const n = parseInt(process.env.PG_POOL_MAX || '', 10); return Number.isFinite(n) && n > 0 ? n : 10; })(),
    idleTimeoutMillis:  30000,
    connectionTimeoutMillis: 5000,
    // Item 14 (collector test slowdown): a transaction left open by a test
    // that timed out mid-query kept its row locks, so every later TRUNCATE
    // in tests/setup.js waited on them with no limit and each following test
    // hung until its 15 s timeout — minutes per file, and only when a first
    // test happened to time out. The server now ends a transaction idle for
    // PG_IDLE_TX_TIMEOUT_MS (default 60 s; 20 s under test), and under test
    // a lock wait fails after PG_LOCK_TIMEOUT_MS (5 s) instead of hanging.
    idle_in_transaction_session_timeout: msEnv('PG_IDLE_TX_TIMEOUT_MS', isTest ? 20000 : 60000),
    ...(isTest || process.env.PG_LOCK_TIMEOUT_MS ? { lock_timeout: msEnv('PG_LOCK_TIMEOUT_MS', 5000) } : {}),
});

// Log pool errors to stderr — do not crash the process
pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err.message);
});

/**
 * dbAll — returns all matching rows as an array of objects.
 * @param {string} sql   — parameterized query
 * @param {Array}  params — query parameters ($1, $2, ...)
 * @returns {Promise<Array>}
 */
async function dbAll(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows;
}

/**
 * dbGet — returns the first matching row, or undefined if none.
 * @param {string} sql
 * @param {Array}  params
 * @returns {Promise<Object|undefined>}
 */
async function dbGet(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows[0];
}

/**
 * dbRun — executes a write query (INSERT/UPDATE/DELETE).
 * Returns the first inserted/modified row if a RETURNING clause is present.
 * @param {string} sql
 * @param {Array}  params
 * @returns {Promise<Object|undefined>}
 */
async function dbRun(sql, params = []) {
    const result = await pool.query(sql, params);
    return result.rows[0];
}

/**
 * dbTransaction — wraps multiple operations in a single atomic transaction.
 * @param {Function} fn — async function that receives a pg Client
 * @returns {Promise<any>} — return value of fn
 */
async function dbTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * isConnected — returns true if the pool can successfully reach the database.
 * Used by GET /api/health.
 * @returns {Promise<boolean>}
 */
async function isConnected() {
    try {
        await pool.query('SELECT 1');
        return true;
    } catch {
        return false;
    }
}

/**
 * closePool — gracefully drains the pool. Call in globalTeardown.js.
 * @returns {Promise<void>}
 */
async function closePool() {
    await pool.end();
}

module.exports = { dbAll, dbGet, dbRun, dbTransaction, isConnected, closePool };
