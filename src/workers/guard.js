// src/workers/guard.js
// A non-reentrant timer body (PR #22 principal #6): setInterval fires on
// schedule whether or not the previous tick finished, so a slow cycle close
// (bias checks, source health, the sweep) overlapped the next one. The
// guarded tick skips while the previous run is still in flight.

'use strict';

/**
 * @param {() => Promise<unknown>} fn
 * @param {{ onSkip?: () => void }} [o]
 * @returns {() => Promise<boolean>} resolves true when it ran, false when skipped
 */
function nonReentrant(fn, { onSkip } = {}) {
    let running = false;
    return async function tick() {
        if (running) {
            if (onSkip) onSkip();
            return false;
        }
        running = true;
        try {
            await fn();
            return true;
        } finally {
            running = false;
        }
    };
}

module.exports = { nonReentrant };
