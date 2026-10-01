-- Migration 073: a database-backed kill switch per ROUTE (Jennifer
-- 2026-09-30, "Stop all HF now + per-route switch").
--
-- The source-level switch (migration 020, data_sources.collection_disabled_*)
-- stops every route of a source. A terms review can rule out ONE route while
-- the others are fine — hugging_face/forum-latest (the Discourse forum's
-- terms ban automated access) while its daily-papers and blog-rss routes
-- resume. This mirrors the source-level switch exactly:
--
-- 1. source_route_state — one row per (source, route) that was ever switched:
--    collection_disabled_at / _reason / _by, as on data_sources.
--      npm run source:disable -- <slug> --route <id> --reason "<why>"
--    sets it; source:enable -- <slug> --route <id> clears it. The runner
--    reads it before every run (no request is made for a disabled route), so
--    it applies before the next run in every process, without a recreate.
--    route_id is validated against the registry by the CLI (never trusted
--    from input); the CHECK below is a second line: registry route ids only
--    ever use lower-case letters, digits and hyphens.
-- 2. source_gate_events gains the events 'route_disabled' / 'route_enabled'.
--    Each names exactly one route (routes = ARRAY[route_id]) and, like
--    'enabled' / 'disabled' / 'refusal_reset', must carry the named
--    approval (GATE_APPROVED_BY, "Name YYYY-MM-DD", PR #22 decision G5) as
--    both actor and approved_by (security L6). The CLI writes the switch and
--    its event in ONE transaction (grumpy L16). The table stays append-only
--    (migration 036 trigger).
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS source_route_state (
    source_id                  UUID NOT NULL REFERENCES data_sources(id),
    route_id                   TEXT NOT NULL,
    collection_disabled_at     TIMESTAMPTZ,
    collection_disabled_reason TEXT,
    collection_disabled_by     TEXT,
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_id, route_id),
    CONSTRAINT source_route_state_route_id CHECK (route_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    -- A disabled route always records why and the named approval behind it.
    CONSTRAINT source_route_state_disabled_named CHECK (
        collection_disabled_at IS NULL
        OR (collection_disabled_reason IS NOT NULL AND btrim(collection_disabled_reason) <> ''
            AND collection_disabled_by ~ '^\S.*\S \d{4}-\d{2}-\d{2}$'))
);

-- The event and named-approval CHECKs are REBUILT from their current
-- definitions plus the two route events, so an event another migration added
-- meanwhile (parallel branches reserve number ranges) is kept, never dropped.
DO $$
DECLARE
    c    RECORD;
    vals TEXT[];
BEGIN
    vals := ARRAY['enabled', 'disabled', 'seeded_active', 'gate_opened', 'gate_closed', 'refusal_reset'];
    FOR c IN SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE conrelid = 'source_gate_events'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%seeded_active%' LOOP
        -- Both renderings: ARRAY['a'::text, ...] and '{a,b}'::text[].
        vals := vals || ARRAY(SELECT m[1] FROM regexp_matches(c.def, '''([a-z_]+)''::text', 'g') AS m)
                     || ARRAY(SELECT unnest(string_to_array(m[1], ',')) FROM regexp_matches(c.def, '''\{([a-z_,]+)\}''::text\[\]', 'g') AS m);
        EXECUTE format('ALTER TABLE source_gate_events DROP CONSTRAINT %I', c.conname);
    END LOOP;
    vals := ARRAY(SELECT DISTINCT v FROM unnest(vals || ARRAY['route_disabled', 'route_enabled']) AS v ORDER BY v);
    EXECUTE format('ALTER TABLE source_gate_events ADD CONSTRAINT source_gate_events_event_check CHECK (event = ANY (%L::text[]))', vals);

    -- The operator events that must carry the named approval (migration 056)
    -- now include the route events. NOT VALID, as in 056: rows written
    -- before 056 are not rechecked; new rows are.
    vals := ARRAY['enabled', 'disabled', 'refusal_reset'];
    FOR c IN SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE conrelid = 'source_gate_events'::regclass AND conname = 'source_gate_events_named_approval' LOOP
        -- Both renderings: ARRAY['a'::text, ...] and '{a,b}'::text[].
        vals := vals || ARRAY(SELECT m[1] FROM regexp_matches(c.def, '''([a-z_]+)''::text', 'g') AS m)
                     || ARRAY(SELECT unnest(string_to_array(m[1], ',')) FROM regexp_matches(c.def, '''\{([a-z_,]+)\}''::text\[\]', 'g') AS m);
        EXECUTE 'ALTER TABLE source_gate_events DROP CONSTRAINT source_gate_events_named_approval';
    END LOOP;
    vals := ARRAY(SELECT DISTINCT v FROM unnest(vals || ARRAY['route_disabled', 'route_enabled']) AS v ORDER BY v);
    EXECUTE format('ALTER TABLE source_gate_events ADD CONSTRAINT source_gate_events_named_approval CHECK ('
        || 'NOT (event = ANY (%L::text[])) OR (approved_by IS NOT NULL AND approved_by ~ %L AND actor = approved_by)) NOT VALID',
        vals, '^\S.*\S \d{4}-\d{2}-\d{2}$');
END $$;

-- A route event names exactly one route.
ALTER TABLE source_gate_events DROP CONSTRAINT IF EXISTS source_gate_events_route_event_one_route;
ALTER TABLE source_gate_events ADD CONSTRAINT source_gate_events_route_event_one_route
    CHECK (event NOT IN ('route_disabled', 'route_enabled')
           OR (routes IS NOT NULL AND cardinality(routes) = 1 AND routes[1] ~ '^[a-z0-9][a-z0-9-]{0,63}$'));
