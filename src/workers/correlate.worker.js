// src/workers/correlate.worker.js
// BullMQ worker handler for the 'correlate' queue.
//
// Cross-platform correlation is NOT IMPLEMENTED (PR #22 grumpy M7): no
// identity signal exists on identity-free data, and designing one needs the
// DPIA (spec §20). Nothing enqueues correlate jobs; a job that reaches this
// worker anyway (a stale queue, a manual add) COMPLETES refused, with the
// gate's status and reason — never processed, never retried.

'use strict';

const { correlationStatus } = require('../pipeline/correlation-gate');

/**
 * Refuse a correlate job with the DPIA gate's status (awaiting_dpia,
 * disabled, misconfigured or not_implemented) and reason.
 * @param {{ data: object }} job
 * @param {{ env?: object }} [o]
 * @returns {Promise<{ correlated: false, refused: string, reason: string }>}
 */
async function processCorrelateJob(job, { env = process.env } = {}) {
    const gate = correlationStatus(env);
    return { correlated: false, refused: gate.status, reason: gate.reason };
}

module.exports = { processCorrelateJob };
