-- Migration 076: rate-limit holds — held routes from the worker, streaks
-- (security review F1 / F2 / F3 / F5 and grumpy review #2 / #5 of the
-- diagnosis 2026-10-01 fix; migration 075 added the holds).
--
-- What changes against migration 075's description:
--   - evidence (src/collectors/rate-limit.js): a 403 is a rate limit only
--     with x-ratelimit-remaining 0 or GitHub's rate-limit wording as its
--     JSON message (anchored). Retry-After alone no longer classifies a 403;
--     it only lengthens a classified hold. A bot wall (incl. the
--     cf-mitigated: challenge header) is never a rate limit.
--   - rate_limited_hosts entries now carry two streaks:
--       { "<hostname>": { "until": <ISO>, "http_status": <int>,
--                         "signal": <text>, "count": <int>, "weak": <int> } }
--     count = consecutive rate limits of the host: the hold floor doubles
--     with each (60, 120, 240 s …, cap 24 h); weak = consecutive body-only
--     ones: the 5th is treated as a REFUSAL (fail closed). An expired hold
--     is kept for its streak until the host's next success (or 7 days).
--     Keys are hostnames (no port). Entries without the new fields read as
--     count 1, weak 0 (rate-limit.js sanitizeHolds), so no backfill.
--   - holds are shared: the worker merges every row's holds per host, so a
--     host held for one source is held for every source (and the terms
--     fetch) that contacts it.
--
-- 1. source_collection_state.rate_limited_routes — { "<route id>": <ISO> }:
--    the routes the WORKER found held (it sees the real env; the web process
--    sees only "set" for credential env vars and cannot recompute
--    env-derived hosts), each until its first host frees. GET /api/sources
--    reads it, and publishes hosts only when the registry names them
--    ("configured host" otherwise — a contract feed host never leaks).
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS only; no existing row
-- is rewritten. The CHECK keeps rate_limited_routes a JSON object.

ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS rate_limited_routes JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_collection_state_rate_limited_routes_object') THEN
        ALTER TABLE source_collection_state
            ADD CONSTRAINT source_collection_state_rate_limited_routes_object
            CHECK (jsonb_typeof(rate_limited_routes) = 'object');
    END IF;
END
$$;
