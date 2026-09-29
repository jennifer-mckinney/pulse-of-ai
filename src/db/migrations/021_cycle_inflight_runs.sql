-- Migration 021: in-flight runs of a collection cycle (G10-2, P10-11).
--
-- A cycle job (processing_jobs, triggered_by 'cron') was closed on age alone,
-- so a run still scoring into it lost its posts from the cycle's bias
-- checks, and two workers could close the same cycle (bias checks twice).
-- Now a run increments inflight_runs when it joins a cycle and decrements it
-- when it leaves; closeCycles claims only cycles with no run in flight (or
-- past a hard age cap), atomically, with FOR UPDATE SKIP LOCKED, moving them
-- to the transient status 'closing' before running the bias checks once.
--
-- Additive and idempotent.

ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS inflight_runs INTEGER NOT NULL DEFAULT 0;
