// src/pipeline/correlation-gate.js
// The DPIA gate for cross-platform correlation (spec §20; PRD FR-28; BRD R3).
//
// Correlation of behavioural signals is high-risk processing under GDPR
// Article 35: the spec, PRD and BRD all require a completed DPIA before it
// ships. Until then it stays OFF — explicitly, not silently:
//   - status 'awaiting_dpia' (default): CORRELATION_DPIA_REF is not set;
//   - status 'disabled': a DPIA is recorded but CORRELATION_ENABLED is not
//     'true' (the operator's switch);
//   - status 'misconfigured': enabled with a DPIA but no deployment salt
//     (CORRELATION_SALT) — the spec forbids a default salt;
//   - status 'enabled': all three set.
// The trigger (the embed worker, after a post's embedding is stored — spec
// §20 "a background step after embeddings are stored") enqueues a correlate
// job only when enabled; the correlate worker re-checks and refuses
// otherwise; GET /api/health serves the status and reason.

'use strict';

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/** @returns {{ enabled: boolean, status: string, reason: string }} */
function correlationStatus(env = process.env) {
    if (!nonEmpty(env.CORRELATION_DPIA_REF)) {
        return {
            enabled: false, status: 'awaiting_dpia',
            reason: 'Cross-platform correlation is off until a DPIA is completed (spec §20, GDPR Article 35): '
                + 'set CORRELATION_DPIA_REF to the completed DPIA reference, then CORRELATION_ENABLED=true.',
        };
    }
    if (!/^(true|1|yes|on)$/i.test(String(env.CORRELATION_ENABLED || '').trim())) {
        return { enabled: false, status: 'disabled', reason: 'A DPIA is recorded; correlation is switched off (CORRELATION_ENABLED is not true).' };
    }
    if (!nonEmpty(env.CORRELATION_SALT)) {
        return { enabled: false, status: 'misconfigured', reason: 'CORRELATION_SALT (the per-deployment salt) is not set; the spec forbids a default salt.' };
    }
    return { enabled: true, status: 'enabled', reason: `enabled under DPIA ${env.CORRELATION_DPIA_REF.trim()}` };
}

module.exports = { correlationStatus };
