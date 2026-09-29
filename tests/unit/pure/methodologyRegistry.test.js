// tests/unit/pure/methodologyRegistry.test.js
// P0-2: migration 009 and the shared methodology registry (the source
// scripts/seed.js inserts from) must agree FIELD FOR FIELD. Parses the SQL
// file directly — no database — so any drift fails the pure loop instantly.

'use strict';

const fs = require('fs');
const path = require('path');
const { METHODOLOGY_VERSIONS } = require('../../../src/config/methodology-registry');
const { NARRATION_COMPONENT, NARRATION_VERSION, REPRODUCE_COMMAND } = require('../../../src/config/audit-narration');

const SQL = fs.readFileSync(
    path.join(__dirname, '../../../src/db/migrations/009_methodology_registration.sql'),
    'utf8',
);

// One INSERT per registered row, in 009's fixed shape:
//   VALUES ('component', 'version', 'model_name', $cfg$…$cfg$::jsonb, $just$…$just$)
//   ON CONFLICT (component, version) DO NOTHING;
const ROW_RE = /INSERT INTO methodology_versions \(component, version, model_name, config, justification\)\s*VALUES \(\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*\$cfg\$([\s\S]*?)\$cfg\$::jsonb,\s*\$just\$([\s\S]*?)\$just\$\s*\)\s*ON CONFLICT \(component, version\) DO NOTHING;/g;

function parse009() {
    const unq = (s) => s.replace(/''/g, "'");
    return [...SQL.matchAll(ROW_RE)].map(m => ({
        component: unq(m[1]),
        version: unq(m[2]),
        model_name: unq(m[3]),
        config: JSON.parse(m[4]),
        justification: m[5],
    }));
}

// Registry lookup by component@version: a component may list several
// versions (history), so 009's rows are matched to the exact version.
const registry = (component, version) => METHODOLOGY_VERSIONS.find(
    m => m.component === component && (version === undefined || m.version === version));
const latest = (component) => METHODOLOGY_VERSIONS.filter(m => m.component === component).pop();

const SQL_011 = fs.readFileSync(
    path.join(__dirname, '../../../src/db/migrations/011_audit_narration_demo.sql'),
    'utf8',
);
// 011's shape: 009's columns plus effective_from = clock_timestamp().
const ROW_011_RE = /INSERT INTO methodology_versions \(component, version, model_name, config, justification, effective_from\)\s*VALUES \(\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*\$cfg\$([\s\S]*?)\$cfg\$::jsonb,\s*\$just\$([\s\S]*?)\$just\$,\s*clock_timestamp\(\)\s*\)\s*ON CONFLICT \(component, version\) DO NOTHING;/g;
function parse011() {
    return [...SQL_011.matchAll(ROW_011_RE)].map(m => ({
        component: m[1], version: m[2], model_name: m[3],
        config: JSON.parse(m[4]), justification: m[5],
    }));
}

describe('migration 009 ↔ methodology registry (seed.js source)', () => {
    const rows = parse009();

    test('009 registers exactly bias@1.1.0, ingest@1.0.0 and audit_narration@1.1.0', () => {
        expect(rows.map(r => `${r.component}@${r.version}`)).toEqual([
            'bias@1.1.0', 'ingest@1.0.0', 'audit_narration@1.1.0',
        ]);
        // Every INSERT in the file was matched by the strict parser (no
        // hand-edited statement slipping past the comparison).
        expect((SQL.match(/INSERT INTO/g) || []).length).toBe(rows.length);
    });

    test.each(['bias', 'ingest', 'audit_narration'])('%s agrees field for field', (component) => {
        const sqlRow = rows.find(r => r.component === component);
        const reg = registry(component, sqlRow && sqlRow.version);
        expect(sqlRow).toBeDefined();
        expect(sqlRow).toEqual({
            component: reg.component,
            version: reg.version,
            model_name: reg.model_name,
            config: reg.config,
            justification: reg.justification,
        });
    });

    test('every INSERT is idempotent (ON CONFLICT (component, version) DO NOTHING)', () => {
        // ROW_RE only matches an INSERT that ends in the conflict clause, and
        // the first test proves every INSERT matched — so each one carries it.
        const inserts = (SQL.match(/INSERT INTO/g) || []).length;
        const guarded = (SQL.match(/ON CONFLICT \(component, version\) DO NOTHING;/g) || []).length;
        expect(inserts).toBeGreaterThan(0);
        expect(guarded).toBe(inserts);
        expect(SQL).not.toMatch(/DO UPDATE/);
    });

    test('the bias row carries the P0-3 parity layer note', () => {
        const bias = rows.find(r => r.component === 'bias');
        expect(bias.config.layer_notes).toEqual({
            platform_sentiment_parity: 'parity measured across source categories (platform), not user demographics',
        });
        // P1-9: the 008 vocabulary fold is recorded in the justification.
        expect(bias.justification).toMatch(/migration 008 folded .*demographic_parity.*platform_sentiment_parity/);
        expect(bias.justification).toMatch(/read-time synonym mapping/);
    });

    test('the 009 audit_narration row is the released 1.1.0 with the real replay command', () => {
        const narr = rows.find(r => r.component === 'audit_narration');
        expect(narr.component).toBe(NARRATION_COMPONENT);
        expect(narr.version).toBe('1.1.0');
        expect(narr.config.reproduce_command).toBe(REPRODUCE_COMMAND);
        expect(REPRODUCE_COMMAND).toBe('npm run replay -- --post {post_id}');
    });
});

describe('migration 011 ↔ methodology registry (audit_narration@1.2.0)', () => {
    const rows = parse011();

    test('011 registers exactly audit_narration@1.2.0, idempotently', () => {
        expect(rows.map(r => `${r.component}@${r.version}`)).toEqual(['audit_narration@1.2.0']);
        expect((SQL_011.match(/INSERT INTO/g) || []).length).toBe(1);
        expect(SQL_011).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE/);
    });

    test('agrees field for field with the registry entry', () => {
        const reg = registry('audit_narration', '1.2.0');
        expect(rows[0]).toEqual({
            component: reg.component,
            version: reg.version,
            model_name: reg.model_name,
            config: reg.config,
            justification: reg.justification,
        });
    });

    test('the renderer version is the newest registered audit_narration row (011)', () => {
        expect(latest('audit_narration').version).toBe(NARRATION_VERSION);
        expect(rows[0].version).toBe(NARRATION_VERSION);
        expect(rows[0].config.reproduce_command).toBe(REPRODUCE_COMMAND);
        expect(rows[0].config.ingest_branches).toEqual(['live_source', 'demo_feed']);
    });
});

describe('methodology registry shape', () => {
    test('component@version pairs are unique and every row is justified', () => {
        const keys = METHODOLOGY_VERSIONS.map(m => `${m.component}@${m.version}`);
        expect(new Set(keys).size).toBe(keys.length);
        for (const m of METHODOLOGY_VERSIONS) {
            expect(typeof m.model_name).toBe('string');
            expect(m.config && typeof m.config).toBe('object');
            expect(m.justification.length).toBeGreaterThan(40);
        }
    });
});

// P9-5: the embedding model is pinned to a Hugging Face commit and
// registered as methodology row embedding@1.0.0 (migration 012), so every
// stored vector names the exact weights that produced it.
const SQL_012 = fs.readFileSync(
    path.join(__dirname, '../../../src/db/migrations/012_embedding_methodology.sql'),
    'utf8',
);
function parse012() {
    return [...SQL_012.matchAll(ROW_011_RE)].map(m => ({
        component: m[1], version: m[2], model_name: m[3],
        config: JSON.parse(m[4]), justification: m[5],
    }));
}

describe('migration 012 ↔ methodology registry (embedding@1.0.0, P9-5)', () => {
    const rows = parse012();
    const read = (rel) => fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');

    test('012 registers exactly embedding@1.0.0, idempotently, and adds the per-vector column', () => {
        expect(rows.map(r => `${r.component}@${r.version}`)).toEqual(['embedding@1.0.0']);
        expect((SQL_012.match(/INSERT INTO/g) || []).length).toBe(1);
        expect(SQL_012).not.toMatch(/DO UPDATE|UPDATE methodology_versions/);
        expect(SQL_012).toMatch(/ALTER TABLE post_embeddings\s+ADD COLUMN IF NOT EXISTS methodology_version TEXT/);
    });

    test('agrees field for field with the registry entry', () => {
        const reg = registry('embedding', '1.0.0');
        expect(rows[0]).toEqual({
            component: reg.component, version: reg.version, model_name: reg.model_name,
            config: reg.config, justification: reg.justification,
        });
    });

    test('the pinned revision is a full commit SHA, identical everywhere it is set', () => {
        const rev = latest('embedding').config.revision;
        expect(rev).toMatch(/^[0-9a-f]{40}$/);
        expect(latest('embedding').model_name).toBe('sentence-transformers/all-MiniLM-L6-v2');
        // Service default, image default, compose default (embeddings + app roles).
        expect(read('python/embeddings_service.py')).toContain(`"EMBED_MODEL_REVISION", "${rev}"`);
        expect(read('python/Dockerfile')).toContain(`EMBED_MODEL_REVISION=${rev}`);
        const compose = read('docker-compose.yml');
        expect(compose.split(`EMBED_MODEL_REVISION: \${EMBED_MODEL_REVISION:-${rev}}`).length - 1).toBe(2);
        expect(read('src/pipeline/embeddings.js')).toMatch(/require\('\.\.\/config\/methodology-registry'\)/);
    });
});

// ─── Migration 013 + code ↔ registry alignment (ADR 0001) ────────────────────
// The replay tool reported drift between the registered relevance / discourse
// rows and the code. New versions describe the code exactly; these tests
// hold the code, the registry and migration 013 to one another.
describe('migration 013 ↔ methodology registry (alignment)', () => {
    const { CURRENT_VERSIONS } = require('../../../src/config/methodology-registry');
    const relevanceCode = require('../../../src/pipeline/relevance');
    const discourseCode = require('../../../src/pipeline/discourse');
    const sentimentCode = require('../../../src/pipeline/sentiment');
    const { PII_FIELDS } = require('../../../src/pipeline/ingest');
    const { STAGES } = require('../../../src/audit/replay');
    const { generate } = require('../../../scripts/generate-methodology-migration');

    const SQL_013 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/013_methodology_alignment.sql'), 'utf8');
    const rows = [...SQL_013.matchAll(ROW_011_RE)].map(m => ({
        component: m[1], version: m[2], model_name: m[3],
        config: JSON.parse(m[4]), justification: m[5],
    }));
    const KEYS = ['sentiment@1.0.0', 'relevance@1.0.0', 'discourse@1.0.0-DQI',
        'relevance@1.1.0', 'discourse@1.1.0-DQI', 'ingest@1.1.0'];

    test('013 registers the 1.0.0 predecessors first, then the aligned versions', () => {
        expect(rows.map(r => `${r.component}@${r.version}`)).toEqual(KEYS);
        expect((SQL_013.match(/INSERT INTO/g) || []).length).toBe(rows.length);
        expect(SQL_013).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE/);
    });

    test('013 is exactly what the generator emits from the registry', () => {
        expect(SQL_013.endsWith(generate(KEYS))).toBe(true);
    });

    test.each(KEYS)('%s agrees field for field', (key) => {
        const [component, version] = key.split('@');
        const row = rows.find(r => r.component === component && r.version === version);
        const reg = registry(component, version);
        expect(row).toEqual({
            component: reg.component, version: reg.version, model_name: reg.model_name,
            config: reg.config, justification: reg.justification,
        });
    });

    test('the code implements the CURRENT versions', () => {
        expect(CURRENT_VERSIONS).toEqual(expect.objectContaining({
            sentiment: '1.0.0', relevance: '1.1.0', discourse: '1.1.0-DQI', ingest: '1.1.0',
        }));
    });

    test('relevance@1.1.0 is the code: lexicon, score rule, model and embed gate', () => {
        const reg = registry('relevance', '1.1.0');
        expect(reg.config.keywords).toEqual(relevanceCode.KEYWORD_LIST);
        expect(reg.config.score_per_match).toBe(1 / relevanceCode.KEYWORD_LIST.length);
        expect(reg.config.embed_gate_min_score).toBe(relevanceCode.EMBED_GATE_MIN_SCORE);
        expect(reg.model_name).toBe(relevanceCode.MODEL_NAME);
        // Replay reports no config drift against the aligned row.
        expect(STAGES.relevance.configDrift(reg.config)).toEqual([]);
        // …and it did against the 1.0.0 row (the drift that motivated 013).
        expect(STAGES.relevance.configDrift(registry('relevance', '1.0.0').config)).not.toEqual([]);
    });

    test('the embed gate is reachable: one keyword match passes, none does not', () => {
        const one = relevanceCode.computeRelevance('A new machine learning result.');
        expect(one.matchedKeywords).toEqual(['machine learning']);
        expect(relevanceCode.passesEmbedGate(one.score)).toBe(true);
        expect(relevanceCode.passesEmbedGate(relevanceCode.computeRelevance('Weather today.').score)).toBe(false);
        expect(relevanceCode.passesEmbedGate('0.05')).toBe(true);   // NUMERIC string from pg
        expect(relevanceCode.passesEmbedGate(null)).toBe(false);
    });

    test('discourse@1.1.0-DQI is the code: five equal-weight dimensions', () => {
        const reg = registry('discourse', '1.1.0-DQI');
        expect(Object.keys(reg.config.dimensions).sort()).toEqual([...discourseCode.DQI_DIMENSIONS].sort());
        for (const d of Object.values(reg.config.dimensions)) expect(d.weight).toBe(1 / discourseCode.DQI_DIMENSIONS.length);
        expect(reg.model_name).toBe(discourseCode.MODEL_NAME);
        expect(STAGES.discourse.configDrift(reg.config)).toEqual([]);
    });

    test('sentiment@1.0.0 thresholds are the code thresholds (no new version needed)', () => {
        expect(STAGES.sentiment.configDrift(registry('sentiment', '1.0.0').config)).toEqual([]);
        expect(sentimentCode.POSITIVE_THRESHOLD).toBe(0.05);
    });

    test('ingest@1.1.0 lists exactly the identity fields ingest removes', () => {
        expect(registry('ingest', '1.1.0').config.pii_fields_removed).toEqual(PII_FIELDS);
        expect(registry('ingest', '1.1.0').config.location_basis).toEqual(['content', 'publisher']);
    });
});
