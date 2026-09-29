-- Migration 016: classified collector errors (F10-1, F10-13).
--
-- Error strings from collection can carry upstream detail, so the public
-- surface (GET /api/sources) serves only a CLASSIFICATION of the last error:
-- error_kind (src/collectors/errors.js ERROR_KINDS: access_denied, robots,
-- gate, parse, timeout, network, http_4xx, http_5xx, too_large,
-- redirect_refused, host_refused, deadline, store, internal) and the HTTP
-- status when there was one. The scrubbed free text stays server-side.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS only.

ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS last_error_kind  TEXT;
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS last_http_status INTEGER;

ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS error_kind  TEXT;
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS http_status INTEGER;
