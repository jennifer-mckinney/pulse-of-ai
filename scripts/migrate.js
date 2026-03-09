#!/usr/bin/env node
// scripts/migrate.js
// Runs all SQL migration files in numbered order (001, 002, ...).
// Idempotent: tracks completed migrations in a schema_migrations table.
// Usage:
//   node scripts/migrate.js            — run pending migrations
//   node scripts/migrate.js --fresh    — drop all tables, re-run all migrations

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const isFresh  = process.argv.includes('--fresh');
const isTest   = process.env.NODE_ENV === 'test';

// Use test DB on port 5433 when NODE_ENV=test
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
});

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

async function ensureMigrationsTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename    TEXT PRIMARY KEY,
            applied_at  TIMESTAMPTZ DEFAULT NOW()
        )
    `);
}

async function getAppliedMigrations(client) {
    const result = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
    return new Set(result.rows.map(r => r.filename));
}

async function dropAllTables(client) {
    console.log('⚠ --fresh: dropping all tables...');
    await client.query(`
        DROP SCHEMA public CASCADE;
        CREATE SCHEMA public;
        GRANT ALL ON SCHEMA public TO ${process.env.POSTGRES_USER || 'pulse_user'};
        GRANT ALL ON SCHEMA public TO public;
    `);
    console.log('  Schema reset complete.');
}

async function runMigration(client, filename, sql) {
    console.log(`  → Applying ${filename}`);
    await client.query(sql);
    await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename]
    );
}

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        if (isFresh) {
            await dropAllTables(client);
        }

        await ensureMigrationsTable(client);
        const applied = await getAppliedMigrations(client);

        // Read migration files sorted by name (001_, 002_, etc.)
        const files = fs.readdirSync(MIGRATIONS_DIR)
            .filter(f => f.endsWith('.sql'))
            .sort();

        let pendingCount = 0;
        for (const filename of files) {
            if (!isFresh && applied.has(filename)) {
                continue; // already applied
            }
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
            await runMigration(client, filename, sql);
            pendingCount++;
        }

        await client.query('COMMIT');

        if (pendingCount === 0) {
            console.log('✓ All migrations already applied. Nothing to do.');
        } else {
            console.log(`✓ Applied ${pendingCount} migration(s) successfully.`);
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('✗ Migration failed. Transaction rolled back.');
        console.error(err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

main();
