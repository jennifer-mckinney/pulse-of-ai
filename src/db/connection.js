// src/db/connection.js
// PostgreSQL connection pool and Promise-based query helpers.
// All application code uses dbAll/dbGet/dbRun — never the pool directly.
// This abstraction means the pool configuration is in one place and
// tests can mock these helpers without touching pg internals.

'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const isTest = process.env.NODE_ENV === 'test';

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
    max:      10,           // max pool size — adequate for single-node MVP
    idleTimeoutMillis:  30000,
    connectionTimeoutMillis: 5000,
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
