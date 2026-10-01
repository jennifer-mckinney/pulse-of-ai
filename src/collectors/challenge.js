// src/collectors/challenge.js
// Bot-wall (challenge) detection, shared by the HTTP client (a challenge is a
// refusal, never retried — ADR 0001 ruling 5) and the rate-limit classifier
// (a challenge is never a rate limit, whatever else the response says).
// Its own module so http.js and rate-limit.js need no circular require
// (grumpy review #12).
//
// A response is a challenge when
//   - its body is a known bot-wall page (CHALLENGE_RE), or
//   - Cloudflare says so in its documented `cf-mitigated: challenge` header
//     (security review F6) — this works even when the body could not be
//     decoded.

'use strict';

// A body that is a bot-wall challenge page, whatever the status code.
const CHALLENGE_RE = /(cf-chl|challenge-platform|_Incapsula_Resource|datadome|captcha-delivery|Attention Required! \| Cloudflare)/i;

/** Whether the headers carry Cloudflare's challenge marker (case-insensitive). */
function challengeHeader(headers) {
    const v = headers ? headers['cf-mitigated'] : undefined;
    if (v === undefined || v === null) return false;
    return /\bchallenge\b/i.test(Array.isArray(v) ? v.join(',') : String(v));
}

/**
 * Whether a response is a bot-wall challenge.
 * @param {{ headers?: object, body?: string }} res
 */
function isChallenge(res) {
    if (!res) return false;
    return challengeHeader(res.headers) || CHALLENGE_RE.test(typeof res.body === 'string' ? res.body : '');
}

module.exports = { CHALLENGE_RE, challengeHeader, isChallenge };
