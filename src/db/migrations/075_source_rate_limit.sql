-- Migration 075: rate limits are a BACKOFF, not a refusal
-- (diagnosis 2026-10-01, GitHub: one search 403 — JSON body, server
-- Varnish, no Retry-After, 1 in ~724 requests, the same bucket answering
-- 200 6.5 s later — was escalated as a refusal: a 1 h cooldown of the whole
-- source, the unaffected github.blog RSS route paused too, probation and a
-- critical alert).
--
-- A response with POSITIVE rate-limit evidence (HTTP 429; a 403 with
-- x-ratelimit-remaining 0, a Retry-After, or a JSON message naming a rate
-- limit — src/collectors/rate-limit.js) now holds the HOST it came from,
-- per source, until the source's own time (x-ratelimit-reset / Retry-After)
-- with a 60 s floor and a 24 h cap. No request goes to a held host until
-- then. The refused state (migrations 018 and 062: access_denied_*,
-- refused_until, refusal_count, probation_until) is NOT touched, and no
-- critical alert is opened.
--
-- 1. source_collection_state.rate_limited_hosts — the holds in force,
--    { "<host>": { "until": <ISO>, "http_status": <int>, "signal": <text> } }.
--    Per host, so an api.github.com limit never pauses github.blog.
-- 2. source_collection_state.rate_limited_until — when the LAST of those
--    holds passes (NULL when none): the "backing off until" time
--    GET /api/sources serves.
-- 3. source_collection_state.rate_limited_at — when the latest rate limit
--    was recorded.
-- 4. source_collection_state.rate_limit_headers — the allow-listed,
--    scrubbed response headers of the latest rate limit (server, date,
--    retry-after, x-ratelimit-limit / -remaining / -reset / -used /
--    -resource …; never Set-Cookie, auth or any body — src/collectors/
--    http.js refusalHeaders). The body is matched, never stored.
--
-- source_runs.response_headers (migration 062) now also holds those headers
-- on the run row that recorded a rate limit (it was NULL on every run but a
-- refusal's).
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS only; no existing row
-- is rewritten. The CHECK keeps rate_limited_hosts a JSON object.

ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS rate_limited_hosts JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS rate_limited_until TIMESTAMPTZ;
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS rate_limited_at    TIMESTAMPTZ;
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS rate_limit_headers JSONB;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_collection_state_rate_limited_hosts_object') THEN
        ALTER TABLE source_collection_state
            ADD CONSTRAINT source_collection_state_rate_limited_hosts_object
            CHECK (jsonb_typeof(rate_limited_hosts) = 'object');
    END IF;
END
$$;
