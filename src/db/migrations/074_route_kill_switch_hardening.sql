-- Migration 074: hardening of the per-route kill switch (migration 073),
-- from the PR's security and code reviews.
--
-- 1. A disabled route's reason is one line: no control characters
--    (newlines, ANSI escapes), which logs would replay raw (security F10).
--    scripts/source-admin.js refuses them too; this is the second line.
-- 2. The source_gate_events event and named-approval CHECKs are rebuilt
--    again, with a stricter reader than 073's (security F8 / grumpy #5):
--      - only the event list is read from each definition — the list after
--        "event = ANY" or, for the negated list of the approval CHECK,
--        "event <> ALL" — never the approval pattern beside it;
--      - both PostgreSQL renderings, ARRAY['a'::text, ...] and
--        '{a,b}'::text[], and any event name (digits included; 073 read
--        only [a-z_] names — no event on master or in an open PR has
--        another character, so nothing was lost);
--      - the event CHECK is found by its shape and name, not by a LIKE on
--        one event's literal, so no other constraint is rewritten;
--      - a definition whose list cannot be read STOPS the migration rather
--        than dropping events silently.
--    The route events stay in both lists; NOT VALID stays on the approval
--    CHECK (rows written before migration 056 are never rechecked).
-- Idempotent.

ALTER TABLE source_route_state DROP CONSTRAINT IF EXISTS source_route_state_reason_one_line;
ALTER TABLE source_route_state ADD CONSTRAINT source_route_state_reason_one_line
    CHECK (collection_disabled_reason IS NULL OR collection_disabled_reason !~ '[[:cntrl:]]');

DO $$
DECLARE
    c    RECORD;
    seg  TEXT;
    got  TEXT[];
    vals TEXT[];
BEGIN
    -- The event CHECK: every plain "event in a list" CHECK on the table.
    vals := ARRAY['enabled', 'disabled', 'seeded_active', 'gate_opened', 'gate_closed', 'refusal_reset',
                  'route_disabled', 'route_enabled'];
    FOR c IN SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE conrelid = 'source_gate_events'::regclass AND contype = 'c'
               AND conname NOT IN ('source_gate_events_named_approval', 'source_gate_events_route_event_one_route')
               AND pg_get_constraintdef(oid) ~ '^CHECK \(\(event = ANY \(' LOOP
        seg := (regexp_match(c.def, 'event (?:= ANY|<> ALL) \((ARRAY\[[^\]]*\]|''\{[^}]*\}''::text\[\])\)'))[1];
        got := ARRAY(SELECT m[1] FROM regexp_matches(coalesce(seg, ''), '''([^''{}]+)''::text', 'g') AS m)
            || ARRAY(SELECT btrim(unnest(string_to_array(m[1], ',')), '"')
                     FROM regexp_matches(coalesce(seg, ''), '''\{([^}]*)\}''::text\[\]', 'g') AS m);
        IF cardinality(got) = 0 THEN
            RAISE EXCEPTION 'migration 074: cannot read the event list of constraint % (%)', c.conname, c.def;
        END IF;
        vals := vals || got;
        EXECUTE format('ALTER TABLE source_gate_events DROP CONSTRAINT %I', c.conname);
    END LOOP;
    vals := ARRAY(SELECT DISTINCT v FROM unnest(vals) AS v ORDER BY v);
    EXECUTE format('ALTER TABLE source_gate_events ADD CONSTRAINT source_gate_events_event_check CHECK (event = ANY (%L::text[]))', vals);

    -- The operator events that must carry the named approval.
    vals := ARRAY['enabled', 'disabled', 'refusal_reset', 'route_disabled', 'route_enabled'];
    FOR c IN SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
             WHERE conrelid = 'source_gate_events'::regclass AND conname = 'source_gate_events_named_approval' LOOP
        seg := (regexp_match(c.def, 'event (?:= ANY|<> ALL) \((ARRAY\[[^\]]*\]|''\{[^}]*\}''::text\[\])\)'))[1];
        got := ARRAY(SELECT m[1] FROM regexp_matches(coalesce(seg, ''), '''([^''{}]+)''::text', 'g') AS m)
            || ARRAY(SELECT btrim(unnest(string_to_array(m[1], ',')), '"')
                     FROM regexp_matches(coalesce(seg, ''), '''\{([^}]*)\}''::text\[\]', 'g') AS m);
        IF cardinality(got) = 0 THEN
            RAISE EXCEPTION 'migration 074: cannot read the event list of constraint % (%)', c.conname, c.def;
        END IF;
        vals := vals || got;
        EXECUTE 'ALTER TABLE source_gate_events DROP CONSTRAINT source_gate_events_named_approval';
    END LOOP;
    vals := ARRAY(SELECT DISTINCT v FROM unnest(vals) AS v ORDER BY v);
    EXECUTE format('ALTER TABLE source_gate_events ADD CONSTRAINT source_gate_events_named_approval CHECK ('
        || 'NOT (event = ANY (%L::text[])) OR (approved_by IS NOT NULL AND approved_by ~ %L AND actor = approved_by)) NOT VALID',
        vals, '^\S.*\S \d{4}-\d{2}-\d{2}$');
END $$;
