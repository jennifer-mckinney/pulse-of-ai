-- Migration 035: source governance records (PR #10 review P10-14).
--
-- source_gate_events — every change of whether a source may collect, with
--   who and when: 'enabled' / 'disabled' (the database kill switch,
--   scripts/source-admin.js), 'seeded_active' (scripts/seed.js activating a
--   new or retired row — never silently), and 'gate_opened' / 'gate_closed'
--   (the runtime gate status changing between 'collecting' and anything else,
--   recorded by the worker's scheduler from the env it runs with).
-- source_terms_snapshots — a dated SHA-256 of each source's governing terms
--   page, fetched politely through the collector HTTP client where it is
--   reachable (scripts/terms-snapshot.js); walled or refused pages are
--   recorded 'unreachable' with the date and reason and never worked around.
-- Both are additive and append-only.

CREATE TABLE IF NOT EXISTS source_gate_events (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id    UUID NOT NULL REFERENCES data_sources(id),
    slug         TEXT NOT NULL,
    event        TEXT NOT NULL CHECK (event IN ('enabled', 'disabled', 'seeded_active', 'gate_opened', 'gate_closed')),
    gate_status  TEXT,
    actor        TEXT NOT NULL,
    reason       TEXT,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gate_events_source ON source_gate_events (source_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS source_terms_snapshots (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id     UUID REFERENCES data_sources(id),
    slug          TEXT NOT NULL,
    terms_url     TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('fetched', 'unreachable', 'not_fetched')),
    sha256        TEXT,
    http_status   INTEGER,
    bytes         INTEGER,
    reason        TEXT,
    captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_terms_snapshots_slug ON source_terms_snapshots (slug, captured_at DESC);
