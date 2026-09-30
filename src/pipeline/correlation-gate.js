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
//   - status 'unverified': the salt is held by the worker only (the web
//     process gets CORRELATION_SALT_SET=set), and the worker has not yet
//     reported its status through its heartbeat (PR #22 security L1);
//   - status 'not_implemented': all three set — and still OFF (PR #22
//     grumpy M7). Collectors store no author (ADR 0001 D2), so the only
//     signal on identity-free data is post-level (a post's topics plus its
//     posting hour). That is NOT an identity signal: linking on it would
//     merge unrelated posts into fabricated "users". No identity signal is
//     designed and the design needs the DPIA, so
//     correlation cannot be enabled: "not implemented: signal design pending
//     DPIA". There is no 'enabled' status until a signal design lands.
// Nothing enqueues correlate jobs (src/workers/embed.worker.js); the
// correlate worker refuses any job with this status and reason, and
// correlateUser (src/pipeline/correlation.js) throws it; GET /api/health
// serves the status and reason.

'use strict';

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

// Fail closed on a placeholder salt: a salt shared by every deployment makes
// pseudonymous IDs identical across deployments (spec §20 forbids it).
// Standup generates a random 64-hex salt; anything shorter than 16
// characters, a single repeated character (e.g. the CI's 64 zeros), or a
// known placeholder is not a salt.
const PLACEHOLDER_SALTS = new Set(['changeme', 'change-me', 'change_me', 'salt', 'secret', 'pulse-of-ai-default-salt',
    'your-salt-here', 'replace-me', 'example', 'test', 'replace_with_random_64_hex_chars']);
// PR #22 grumpy M8: placeholder SHAPES, not only exact values — .env.example
// ships "replace_with_random_64_hex_chars", and hand-written templates use
// "your_…", "change_me…", "insert…", "…placeholder…", "…example…".
const PLACEHOLDER_SHAPES = [
    /^(replace|your|change|insert|put|enter|set|fill)[_\s-]/i,
    /placeholder|example|changeme|change[_-]me|replace[_-]?me|todo|dummy/i,
];
function isUsableSalt(v) {
    if (!nonEmpty(v)) return false;
    const t = v.trim();
    if (t.length < 16) return false;
    if (/^(.)\1*$/.test(t)) return false;
    if (PLACEHOLDER_SALTS.has(t.toLowerCase()) || /^<.*>$/.test(t) || /^\$\{.*\}$/.test(t)) return false;
    if (PLACEHOLDER_SHAPES.some(re => re.test(t))) return false;
    return true;
}

const NOT_IMPLEMENTED_REASON = 'not implemented: signal design pending DPIA. Collectors store no author, so the only '
    + 'signal available (a post\'s topics plus its posting hour) is not an identity signal; cross-platform correlation '
    + 'cannot be enabled until the DPIA approves an identity-signal design and it is implemented (spec §20; PR #22 grumpy M7).';

/**
 * PR #22 security L1: the web process does not hold CORRELATION_SALT (only
 * the worker computes pseudonyms). It gets a presence flag instead,
 * CORRELATION_SALT_SET=set (docker-compose.yml). Whether the salt is usable:
 *   true / false  — this process holds the salt (worker; host `npm run dev`)
 *                   or knows it is absent;
 *   null          — the salt is set but held only by the worker, so only the
 *                   worker can judge it (its status reaches /api/health via
 *                   Redis, src/workers/heartbeat.js).
 * @returns {boolean|null}
 */
function saltUsableHere(env = process.env) {
    if (nonEmpty(env.CORRELATION_SALT)) return isUsableSalt(env.CORRELATION_SALT);
    return String(env.CORRELATION_SALT_SET || '').trim() === 'set' ? null : false;
}

/**
 * @param {object} [env]
 * @param {{ saltUsable?: boolean|null }} [o]  default: judged from env.CORRELATION_SALT
 * @returns {{ enabled: boolean, status: string, reason: string }}
 */
function correlationStatus(env = process.env, { saltUsable } = {}) {
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
    const usable = saltUsable === undefined ? isUsableSalt(env.CORRELATION_SALT) : saltUsable;
    if (usable === null) {
        return {
            enabled: false, status: 'unverified',
            reason: 'CORRELATION_SALT is set for the worker only (never the web process); the worker, which checks it, has not '
                + 'reported its correlation status, so correlation is reported off here.',
        };
    }
    if (!usable) {
        return {
            enabled: false, status: 'misconfigured',
            reason: 'CORRELATION_SALT (the per-deployment salt) is unset or a placeholder; correlation stays off and no pseudonym is computed (spec §20).',
        };
    }
    // M7: every switch is set, but no identity signal exists — never
    // enabled. Implementing a DPIA-approved signal design is what adds an
    // 'enabled' status here, with its own tests.
    return {
        enabled: false, status: 'not_implemented',
        reason: `${NOT_IMPLEMENTED_REASON} (DPIA ${env.CORRELATION_DPIA_REF.trim()} recorded; switch and salt set.)`,
    };
}

module.exports = { correlationStatus, isUsableSalt, saltUsableHere, NOT_IMPLEMENTED_REASON };
