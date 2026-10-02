-- Migration 077: ONE rate-limit hold store (PR #44 merged into PR #45)
--
-- PR #44 (TLDR, diagnosis 2026-10-01) kept its Retry-After holds as
-- `retry-after:<host>` keys inside source_collection_state.http_cache
-- ({ "until": <ISO>, "status": 429 | 503 }), next to the per-URL
-- validators. PR #45 keeps every rate-limit hold in
-- source_collection_state.rate_limited_hosts (migrations 075-076,
-- src/collectors/rate-limit.js). The two mechanisms are unified into #45's
-- store: the HTTP cache holds validators only again, and a hold can never be
-- rolled back with it (G10-5).
--
-- This migration COPIES every still-active PR #44 key into
-- rate_limited_hosts (the keys stay in http_cache until the runner removes them on the
-- source's next claim, so a previous-release worker still running during a rolling deploy
-- keeps honouring them):
--   - the host is the key's host without a port, lower-cased (#45 holds are
--     keyed by hostname — security F5);
--   - 429 → { signal: "http_429", count: 1 }, 503 → { signal:
--     "retry_after_5xx", count: 0 } (a 5xx's Retry-After is not a rate
--     limit), weak 0, http_status the key's status, at NOW();
--   - until is capped at NOW() + 24 h (rate-limit.js MAX_BACKOFF_MS), a 503's
--     (not a rate limit) at NOW() + 1 h (rate-limit.js MAX_5XX_HOLD_MS);
--   - a host that already has a #45 entry keeps it (its streaks), with the
--     LATER until of the two (never shortened — security N6);
--   - rate_limited_until becomes the later of its value and the moved RATE-LIMIT
--     holds' (a 503's hold never counts: it is not a rate limit).
-- An unparseable `until` is dropped (it never held: #44 read it with
-- Date.parse). The runner also folds such a key in at claim
-- (rate-limit.js legacyHolds), for a previous-release worker that writes one
-- during a rolling deploy.
--
-- A timestamp that does not exist (month 13, hour 99) reads as unparseable
-- instead of aborting the migration (pg_temp.hold_ts, dropped at the end); the
-- host is the key's text before any path, query, fragment or port, as the
-- runner's hostOf() reads it.
--
-- Additive data move, idempotent: a second run finds no `retry-after:` key.

-- A streak count as an integer; anything else reads as 0.
CREATE OR REPLACE FUNCTION pg_temp.hold_count(v text) RETURNS integer AS $fn$
    SELECT CASE WHEN v ~ '^\d{1,6}$' THEN v::integer ELSE 0 END
$fn$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION pg_temp.hold_ts(v text) RETURNS timestamptz AS $fn$
BEGIN
    IF v IS NULL OR v !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$' THEN
        RETURN NULL;
    END IF;
    RETURN v::timestamptz;
EXCEPTION WHEN others THEN
    RETURN NULL;
END
$fn$ LANGUAGE plpgsql IMMUTABLE;

WITH legacy AS (
    SELECT s.source_id,
           regexp_replace(lower(split_part(regexp_replace(substring(e.key FROM length('retry-after:') + 1), '[/?#].*$', ''), ':', 1)), '\.+$', '') AS host,
           -- LEAST ignores NULL: an unparseable until must stay NULL (never a hold).
           CASE WHEN pg_temp.hold_ts(e.value ->> 'until') IS NULL THEN NULL
                ELSE LEAST(pg_temp.hold_ts(e.value ->> 'until'),
                           NOW() + CASE WHEN (e.value ->> 'status') = '503' THEN interval '1 hour' ELSE interval '24 hours' END) END AS until,
           CASE WHEN (e.value ->> 'status') = '503' THEN 503 ELSE 429 END AS status
    FROM source_collection_state s, jsonb_each(s.http_cache) e
    WHERE e.key LIKE 'retry-after:%'
),
live AS (
    SELECT DISTINCT ON (source_id, host) source_id, host, until, status
    FROM legacy
    WHERE until IS NOT NULL AND until > NOW() AND host ~ '^[a-z0-9.-]{1,253}$' AND host LIKE '%.%'
    -- Deterministic: the later until, then a 429 over a 503 (two keys that normalize to
    -- one host with the same expiry).
    ORDER BY source_id, host, until DESC, (status = 503), status
),
entries AS (
    SELECT l.source_id,
           jsonb_object_agg(l.host, CASE
               WHEN s.rate_limited_hosts ? l.host THEN
                   -- The expiry keeps its CAUSE (the runtime combineHold rule): the
                   -- streaks stay the existing entry's; between a 5xx hold and a rate
                   -- limit, signal and status come from the record with the later until
                   -- (a tie goes to the rate limit); two of one class keep the existing.
                   (s.rate_limited_hosts -> l.host) || jsonb_build_object('until', to_char(
                       GREATEST(l.until, pg_temp.hold_ts(s.rate_limited_hosts -> l.host ->> 'until'))
                       AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                   || CASE WHEN (COALESCE(s.rate_limited_hosts -> l.host ->> 'signal', '') = 'retry_after_5xx') IS DISTINCT FROM (l.status = 503)
                             AND (pg_temp.hold_ts(s.rate_limited_hosts -> l.host ->> 'until') IS NULL
                                  OR l.until > pg_temp.hold_ts(s.rate_limited_hosts -> l.host ->> 'until')
                                  OR (l.until = pg_temp.hold_ts(s.rate_limited_hosts -> l.host ->> 'until') AND l.status <> 503))
                           THEN jsonb_build_object(
                               'http_status', l.status,
                               'signal', CASE WHEN l.status = 503 THEN 'retry_after_5xx' ELSE 'http_429' END,
                               'count', CASE WHEN l.status = 503 THEN pg_temp.hold_count(s.rate_limited_hosts -> l.host ->> 'count')
                                             ELSE GREATEST(pg_temp.hold_count(s.rate_limited_hosts -> l.host ->> 'count'), 1) END)
                           -- Two records of one class: the later until also supplies the
                           -- signal and status (the runtime cause rule), the streaks stay.
                           WHEN (COALESCE(s.rate_limited_hosts -> l.host ->> 'signal', '') = 'retry_after_5xx') = (l.status = 503)
                             AND l.until > pg_temp.hold_ts(s.rate_limited_hosts -> l.host ->> 'until')
                           THEN jsonb_build_object(
                               'http_status', l.status,
                               'signal', CASE WHEN l.status = 503 THEN 'retry_after_5xx' ELSE 'http_429' END)
                           ELSE '{}'::jsonb END
               ELSE jsonb_build_object(
                   'until', to_char(l.until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                   'http_status', l.status,
                   'signal', CASE WHEN l.status = 503 THEN 'retry_after_5xx' ELSE 'http_429' END,
                   'count', CASE WHEN l.status = 503 THEN 0 ELSE 1 END,
                   'weak', 0,
                   'at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
           END) AS holds,
           -- rate_limited_until counts rate limits only: a 503's hold is enforced
           -- (retry_after_5xx) but never a rate limit (as state.saveHolds).
           MAX(l.until) FILTER (WHERE l.status <> 503) AS last_until
    FROM live l JOIN source_collection_state s ON s.source_id = l.source_id
    GROUP BY l.source_id
)
UPDATE source_collection_state s
SET rate_limited_hosts = s.rate_limited_hosts || COALESCE(e.holds, '{}'::jsonb),
    rate_limited_until = CASE WHEN e.last_until IS NULL THEN s.rate_limited_until
                              ELSE GREATEST(s.rate_limited_until, e.last_until) END,
    -- The keys STAY in http_cache (copied, not moved): a previous-release worker, still
    -- running during a rolling deploy, reads only those keys. The runner removes them on
    -- the source's next claim (rate-limit.js legacyHolds).
    updated_at = NOW()
FROM (SELECT DISTINCT source_id FROM legacy) moved
LEFT JOIN entries e ON e.source_id = moved.source_id
WHERE s.source_id = moved.source_id;

DROP FUNCTION IF EXISTS pg_temp.hold_count(text);
DROP FUNCTION IF EXISTS pg_temp.hold_ts(text);
