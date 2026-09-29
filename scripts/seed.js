#!/usr/bin/env node
// scripts/seed.js
// Seeds the database with:
//   1. The 51 data_sources of the source registry of record
//      (src/config/source-registry.js — the workbook, ADR 0001). The old
//      50-row seed list is gone; migration 013 retired its rows (history kept).
//   2. methodology_versions — every row of src/config/methodology-registry.js
//      (shared with migrations 009, 011, 012, 014, 015, 017 and 024). The current
//      (latest registered) version of each component: sentiment 1.0.0,
//      relevance 1.1.0, discourse 1.1.0-DQI, bias 1.1.0, ingest 1.4.0,
//      audit_narration 1.3.0, embedding 1.0.0; every earlier released row
//      of a component is inserted too and never edited.
// Safe to re-run. Registry rows are UPSERTED (name = slug): display name,
// type, category and non-secret config follow the registry of record on
// every run, and a registry row is always active (its runtime gate status —
// collecting, awaiting_*, blocked, disabled — comes from env, never from
// this flag). Methodology rows are INSERT ... ON CONFLICT DO NOTHING
// (released rows are never edited). Demo feeds (source_type 'demo') are
// not touched.

'use strict';

require('dotenv').config();
const { dbRun, closePool } = require('../src/db/connection');
const { SOURCES } = require('../src/config/source-registry');
const { METHODOLOGY_VERSIONS } = require('../src/config/methodology-registry');

/**
 * Non-secret data_sources.config for a registry entry. Env var NAMES are
 * listed so the row documents what the source waits for; values never are.
 */
function sourceConfig(s) {
    return {
        registry: 'src/config/source-registry.js',
        workbook_rank: s.rank,
        region: s.region,
        home_city: s.homeCity,
        auth_kind: s.auth.kind,
        routes: s.routes.map(r => ({ id: r.id, adapter: r.adapter, requires: r.requires || [] })),
        poll_interval_sec: s.pollIntervalSec,
        terms_url: s.termsUrl,
        attribution: s.attribution || null,
    };
}

async function seedSources() {
    let n = 0;
    for (const s of SOURCES) {
        await dbRun(
            `INSERT INTO data_sources (name, display_name, source_type, category, config, active)
             VALUES ($1, $2, $3, $4, $5::jsonb, TRUE)
             ON CONFLICT (name) DO UPDATE
                SET display_name = EXCLUDED.display_name,
                    source_type  = EXCLUDED.source_type,
                    category     = EXCLUDED.category,
                    config       = EXCLUDED.config,
                    active       = TRUE,
                    retired_at   = NULL,
                    retired_note = NULL`,
            [s.slug, s.name, s.sourceType, s.category, JSON.stringify(sourceConfig(s))],
        );
        n++;
    }
    return n;
}

async function seedMethodology() {
    let inserted = 0;
    for (const m of METHODOLOGY_VERSIONS) {
        const result = await dbRun(
            `INSERT INTO methodology_versions (component, version, model_name, config, justification)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (component, version) DO NOTHING
             RETURNING id`,
            [m.component, m.version, m.model_name, JSON.stringify(m.config), m.justification],
        );
        if (result) inserted++;
    }
    return inserted;
}

async function main() {
    const sources = await seedSources();
    const methods = await seedMethodology();
    console.log(`✓ Seed complete: ${sources} registry data_sources upserted, ${methods} methodology_versions inserted.`);
}

/* istanbul ignore next -- process entry point */
if (require.main === module) {
    main()
        .then(() => closePool())
        .catch(async (err) => {
            console.error('✗ Seed failed:', err.message);
            await closePool().catch(() => {});
            process.exit(1);
        });
}

module.exports = { sourceConfig, seedSources, seedMethodology, main };
