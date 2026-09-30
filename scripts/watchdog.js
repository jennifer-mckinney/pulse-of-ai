#!/usr/bin/env node
// scripts/watchdog.js — the external watchdog (PR #22 principal #12).
//
//   node scripts/watchdog.js          poll forever (compose service `watchdog`)
//   node scripts/watchdog.js --once   one poll, then exit (0 = nothing open,
//                                     1 = at least one condition open)
//
// Runs OUTSIDE the worker, in its own container, so a dead worker is still
// noticed. See src/watchdog/index.js for what it does and README "Alerting"
// for the settings (WATCHDOG_*, SMTP_*). It never exits on a failed poll:
// the API or the database being down is an alert condition, not a crash.

'use strict';

require('dotenv').config();
const db = require('../src/db/connection');
const { readConfig } = require('../src/watchdog/config');
const { scrub } = require('../src/collectors/redact');
const { Watchdog } = require('../src/watchdog');

/* istanbul ignore next -- CLI entry point */
async function main() {
    const once = process.argv.includes('--once');
    const wd = new Watchdog({ cfg: readConfig(process.env), db });
    const shutdown = () => { wd.stop(); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    // A stray rejection (e.g. a pg pool error event) must not kill the loop.
    process.on('unhandledRejection', (err) => {
        console.error('[watchdog] unhandled rejection:', scrub(String(err && err.message)).slice(0, 300));
    });
    if (once) {
        await wd.init();
        const r = await wd.pollOnce();
        await db.closePool().catch(() => {});
        process.exit(r.open.length ? 1 : 0);
    }
    await wd.run();
    await db.closePool().catch(() => {});
    process.exit(0);
}

/* istanbul ignore next -- CLI entry point */
if (require.main === module) {
    main().catch((err) => {
        console.error('[watchdog] fatal:', scrub(String(err && err.message)).slice(0, 300));
        process.exit(1);
    });
}
