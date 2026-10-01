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

    test('011 registered 1.2.0 (superseded by 017\'s 1.3.0, never edited)', () => {
        expect(rows[0].version).toBe('1.2.0');
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

// ─── Migration 014 + code ↔ registry alignment (ADR 0001) ────────────────────
// The replay tool reported drift between the registered relevance / discourse
// rows and the code. New versions describe the code exactly; these tests
// hold the code, the registry and migration 014 to one another.
describe('migration 014 ↔ methodology registry (alignment)', () => {
    const { CURRENT_VERSIONS } = require('../../../src/config/methodology-registry');
    const relevanceCode = require('../../../src/pipeline/relevance');
    const discourseCode = require('../../../src/pipeline/discourse');
    const sentimentCode = require('../../../src/pipeline/sentiment');
    const { PII_FIELDS } = require('../../../src/pipeline/ingest');
    const { STAGES } = require('../../../src/audit/replay');
    const { generate } = require('../../../scripts/generate-methodology-migration');

    const SQL_014 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/014_methodology_alignment.sql'), 'utf8');
    const rows = [...SQL_014.matchAll(ROW_011_RE)].map(m => ({
        component: m[1], version: m[2], model_name: m[3],
        config: JSON.parse(m[4]), justification: m[5],
    }));
    const KEYS = ['sentiment@1.0.0', 'relevance@1.0.0', 'discourse@1.0.0-DQI',
        'relevance@1.1.0', 'discourse@1.1.0-DQI', 'ingest@1.1.0'];

    test('014 registers the 1.0.0 predecessors first, then the aligned versions', () => {
        expect(rows.map(r => `${r.component}@${r.version}`)).toEqual(KEYS);
        expect((SQL_014.match(/INSERT INTO/g) || []).length).toBe(rows.length);
        expect(SQL_014).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE/);
    });

    test('014 is exactly what the generator emits from the registry', () => {
        expect(SQL_014.endsWith(generate(KEYS))).toBe(true);
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
            sentiment: '1.0.0', relevance: '1.2.0', discourse: '1.1.0-DQI', ingest: '1.8.0',
        }));
    });

    test('relevance@1.1.0 is its code (kept for replay since 1.2.0): lexicon, score rule, model and embed gate', () => {
        const reg = registry('relevance', '1.1.0');
        const v11 = relevanceCode.VERSIONS['1.1.0'];
        expect(reg.config.keywords).toEqual(v11.lexicon);
        expect(reg.config.keywords).toEqual(relevanceCode.KEYWORD_LIST_1_1_0);
        expect(reg.config.score_per_match).toBe(1 / v11.lexicon.length);
        expect(reg.config.embed_gate_min_score).toBe(1 / 20);
        expect(reg.model_name).toBe(v11.model);
        // Replay reports no config drift against the aligned row.
        expect(STAGES.relevance.configDrift(reg.config, '1.1.0')).toEqual([]);
        // …and it did against the 1.0.0 row (the drift that motivated 014).
        expect(STAGES.relevance.configDrift(registry('relevance', '1.0.0').config, '1.0.0')).not.toEqual([]);
    });

    test('the embed gate is reachable: one keyword match passes, none does not', () => {
        const one = relevanceCode.computeRelevance('A new machine learning result.');
        expect(one.matchedKeywords).toEqual(['machine learning']);
        expect(relevanceCode.passesEmbedGate(one.score)).toBe(true);
        expect(relevanceCode.passesEmbedGate(relevanceCode.computeRelevance('Weather today.').score)).toBe(false);
        expect(relevanceCode.passesEmbedGate('0.05')).toBe(true);   // NUMERIC string from pg (a 1.1.0 score)
        expect(relevanceCode.passesEmbedGate(String(1 / 21))).toBe(true);
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

    test('ingest@1.1.0 lists exactly the identity fields ingest removes (unchanged in 1.2.0)', () => {
        expect(registry('ingest', '1.1.0').config.pii_fields_removed).toEqual(PII_FIELDS);
        expect(registry('ingest', '1.1.0').config.location_basis).toEqual(['content', 'publisher']);
    });
});

describe('migration 015 ↔ methodology registry (ingest@1.2.0)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const { redactIdentities } = require('../../../src/collectors/normalize');
    const { PII_FIELDS } = require('../../../src/pipeline/ingest');
    const SQL_015 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/015_ingest_text_redaction.sql'), 'utf8');

    test('015 is exactly the generated ingest@1.2.0 row, idempotent, and edits nothing', () => {
        expect(SQL_015.endsWith(generate(['ingest@1.2.0']))).toBe(true);
        expect((SQL_015.match(/INSERT INTO/g) || []).length).toBe(1);
        expect(SQL_015).toMatch(/ON CONFLICT \(component, version\) DO NOTHING;/);
        expect(SQL_015).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE/);
    });

    test('ingest@1.2.0 stays registered (superseded by 1.3.0, never edited)', () => {
        const reg = registry('ingest', '1.2.0');
        expect(reg.config.pii_fields_removed).toEqual(PII_FIELDS);
        expect(redactIdentities('a@b.co @x1')).toBe(`${reg.config.text_redaction.email_addresses} ${reg.config.text_redaction.at_handles}`);
    });
});

describe('migration 017 ↔ methodology registry (ingest@1.3.0, decision D2)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const { redactIdentities } = require('../../../src/collectors/normalize');
    const { PII_FIELDS } = require('../../../src/pipeline/ingest');
    const SQL_017 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/017_ingest_provenance.sql'), 'utf8');

    test('017 adds the provenance column additively and ends with exactly the generated ingest@1.3.0 row', () => {
        expect(SQL_017.endsWith(generate(['ingest@1.3.0', 'audit_narration@1.3.0']))).toBe(true);
        expect((SQL_017.match(/INSERT INTO/g) || []).length).toBe(2);
        expect(SQL_017).toMatch(/ALTER TABLE raw_posts ADD COLUMN IF NOT EXISTS provenance_fingerprint TEXT;/);
        expect(SQL_017).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE|DROP/);
    });

    test('ingest@1.3.0 stays registered with the D2 claim (superseded by 1.4.0, never edited)', () => {
        const reg = registry('ingest', '1.3.0');
        expect(reg.config.pii_fields_removed).toEqual(PII_FIELDS);
        const t = reg.config.text_redaction;
        expect(redactIdentities('a@b.co @x1')).toBe(`${t.email_addresses} ${t.at_handles}`);
        expect(redactIdentities('call (415) 555-2671')).toBe('call [phone]');
        expect(reg.config.privacy_claim).toBeDefined();
        expect(redactIdentities('see https://github.com/alice')).toBe(`see ${t.identity_links}`);
        expect(redactIdentities('ok cc Jane Doe')).toBe(`ok ${t.cc_names}`);
        // The precise claim (D2 b), verbatim in config and justification.
        const claim = 'identity fields are never stored; e-mail addresses, handles, phone numbers, sign-offs and profile links in text are redacted; free text may still contain names mentioned in content';
        expect(reg.config.privacy_claim).toBe(claim);
        expect(reg.justification).toContain(`Precise claim: ${claim}.`);
        expect(reg.justification).toContain('"both yet we need an identifier to be able to prove the audit traceability back to the source."');
    });

    test('audit_narration@1.3.0 registers the provenance wording (superseded by 1.4.0, never edited)', () => {
        const { NARRATION_VERSION, VERIFY_PROVENANCE_COMMAND, PROVENANCE_VERIFIABLE } = require('../../../src/config/audit-narration');
        const reg = registry('audit_narration', '1.3.0');
        expect(latest('audit_narration').version).toBe(NARRATION_VERSION);
        expect(NARRATION_VERSION).toBe('1.5.0');
        expect(reg.config.verify_provenance_command).toBe(VERIFY_PROVENANCE_COMMAND);
        expect(reg.justification).toContain(PROVENANCE_VERIFIABLE);
    });
});

// Grumpy NIT a (PR #8): scripts/seed.js's header comment once claimed every
// methodology row was "all v1.0.0" while bias was already 1.1.0. The header
// must state, per component, the version the registry (the source seed.js
// inserts from) actually registers — so a registry bump without a header
// update fails here. Reads seed.js as TEXT (requiring it would open a pool).
describe('scripts/seed.js header ↔ methodology registry (grumpy NIT a)', () => {
    const SEED = fs.readFileSync(path.join(__dirname, '../../../scripts/seed.js'), 'utf8');

    // The leading comment block (after the shebang), `//` stripped and the
    // wrapped lines joined, then narrowed to the methodology item ("2. …"
    // up to the "Safe to re-run" line).
    function methodologyHeader() {
        const lines = SEED.split('\n');
        const comment = [];
        for (const line of lines.slice(lines[0].startsWith('#!') ? 1 : 0)) {
            if (!line.startsWith('//')) break;
            comment.push(line.replace(/^\/\/\s?/, '').trim());
        }
        const text = comment.join(' ').replace(/\s+/g, ' ');
        const m = text.match(/\b2\.\s+(.*?)\s+Safe to re-run/);
        return m ? m[1] : '';
    }

    const SEMVER = String.raw`v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9]+)?)`;
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Latest registered version per component (registry order = history).
    const latest = {};
    for (const m of METHODOLOGY_VERSIONS) latest[m.component] = m.version;

    test('the header has a methodology item to check', () => {
        expect(methodologyHeader()).toMatch(/methodology/i);
    });

    test.each(Object.keys(latest))('header states the registered version for %s', (component) => {
        const re = new RegExp(`(?<![\\w])${escapeRe(component)}(?![\\w])\\s+${SEMVER}`);
        const m = methodologyHeader().match(re);
        expect(m && m[1]).toBe(latest[component]);
    });

    test('every "<component> <version>" pair in the header is a registered row', () => {
        const registered = new Set(METHODOLOGY_VERSIONS.map((m) => `${m.component}@${m.version}`));
        const pairs = [...methodologyHeader().matchAll(new RegExp(`([A-Za-z_]+)\\s+${SEMVER}`, 'g'))]
            .map((m) => `${m[1]}@${m[2]}`);
        expect(pairs.length).toBe(Object.keys(latest).length);
        for (const pair of pairs) expect(registered).toContain(pair);
    });

    test('no blanket "all v1.0.0" claim survives', () => {
        expect(methodologyHeader()).not.toMatch(/\ball v?\d+\.\d+\.\d+/i);
    });
});

describe('migration 024 ↔ methodology registry (ingest@1.4.0, Copilot 4129565702)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const { redactIdentities } = require('../../../src/collectors/normalize');
    const SQL_024 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/024_ingest_single_char_handles.sql'), 'utf8');

    test('024 is exactly the generated ingest@1.4.0 row, idempotent, and edits nothing', () => {
        expect(SQL_024.endsWith(generate(['ingest@1.4.0']))).toBe(true);
        expect((SQL_024.match(/INSERT INTO/g) || []).length).toBe(1);
        expect(SQL_024).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE|DROP/);
    });

    test('ingest@1.4.0 keeps the D2 claim and redacts single-character handles (superseded by 1.5.0, never edited)', () => {
        const reg = registry('ingest', '1.4.0');
        const prev = registry('ingest', '1.3.0');
        expect(reg.config.privacy_claim).toBe(prev.config.privacy_claim);
        expect(reg.config.text_redaction.at_handle_min_length).toBe(1);
        expect(redactIdentities('ping @a and @b_ and a@b.co')).toBe('ping @[user] and @[user] and [email]');
    });
});

describe('migration 026 ↔ methodology registry (ingest@1.5.0, Reddit u/ names)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const { redactIdentities } = require('../../../src/collectors/normalize');
    const SQL_026 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/026_ingest_reddit_handles.sql'), 'utf8');

    test('026 is exactly the generated ingest@1.5.0 row, idempotent, and edits nothing', () => {
        expect(SQL_026.endsWith(generate(['ingest@1.5.0']))).toBe(true);
        expect((SQL_026.match(/INSERT INTO/g) || []).length).toBe(1);
        expect(SQL_026).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE|DROP/);
    });

    test('ingest@1.5.0 redacts Reddit user names (superseded by 1.6.0, never edited); 1.4.0 is unchanged', () => {
        const reg = registry('ingest', '1.5.0');
        const prev = registry('ingest', '1.4.0');
        expect(latest('ingest').version).toBe('1.8.0');
        expect(reg.config.text_redaction.reddit_user_handles).toMatch(/u\/\[user\]/);
        expect(prev.config.text_redaction.reddit_user_handles).toBeUndefined();
        expect(reg.config.pii_fields_removed).toEqual(prev.config.pii_fields_removed);
        expect(redactIdentities('thanks u/spez, /u/Jane_Doe and reddit.com/user/bob'))
            .toBe('thanks u/[user], u/[user] and [profile link]');
        expect(redactIdentities('r/MachineLearning and menu/u/x stay')).toBe('r/MachineLearning and menu/u/x stay');
    });
});

describe('migration 027 ↔ methodology registry (bias@1.2.0, decision D3)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const SQL_027 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/027_bias_publisher_location.sql'), 'utf8');

    test('027 is exactly the generated bias@1.2.0 row, idempotent, and edits nothing', () => {
        expect(SQL_027.endsWith(generate(['bias@1.2.0']))).toBe(true);
        expect((SQL_027.match(/INSERT INTO/g) || []).length).toBe(1);
        expect(SQL_027).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE|DROP/);
        expect(SQL_027).toMatch(/"Separate layer, excluded from bias\."/);
    });

    test('bias@1.2.0 excludes publisher-located posts and otherwise equals 1.1.0 (never edited)', () => {
        const reg = registry('bias', '1.2.0');
        const prev = registry('bias', '1.1.0');
        expect(reg.config.location_basis_excluded).toEqual(['publisher']);
        expect(prev.config.location_basis_excluded).toBeUndefined();
        for (const k of ['location_concentration_max', 'platform_parity_max_diff', 'negative_dominance_max',
            'layer_names', 'citations', 'planned_layers', 'layer_order', 'legal_basis']) {
            expect(reg.config[k]).toEqual(prev.config[k]);
        }
        expect(reg.config.layer_notes.platform_sentiment_parity).toBe(prev.config.layer_notes.platform_sentiment_parity);
        expect(reg.config.layer_notes.location_concentration).toMatch(/publisher-location layer/);
        expect(prev.config.layer_notes.location_concentration).toBeUndefined();
        expect(reg.justification).toMatch(/"Separate layer, excluded from bias\."/);
    });
});

describe('migration 028 ↔ methodology registry (bias@1.3.0, P10-5)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const SQL_028 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/028_bias_min_sample.sql'), 'utf8');

    test('028 registers exactly the generated bias@1.3.0 row BEFORE the resolutions that link to it, and removes nothing', () => {
        // PR #22 principal #9: the resolutions set methodology_version_id on
        // insert, so the version row must exist first.
        const gen = generate(['bias@1.3.0']).trim();
        expect(SQL_028).toContain(gen);
        expect(SQL_028.indexOf(gen)).toBeLessThan(SQL_028.indexOf('WITH open_alerts'));
        expect(SQL_028).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE|DROP|TRUNCATE/);
        expect(SQL_028).toMatch(/CREATE TABLE IF NOT EXISTS alert_resolutions/);
    });

    test('the SQL re-evaluation uses the registered minimum sample and threshold', () => {
        const reg = registry('bias', '1.3.0');
        expect(reg.config.location_min_sample).toBe(30);
        expect(SQL_028).toMatch(new RegExp(`content_located < ${reg.config.location_min_sample}\\b`));
        expect(SQL_028).toMatch(new RegExp(`<= ${reg.config.location_concentration_max}\\b`));
        expect(reg.config.location_basis_excluded).toEqual(['publisher']);
    });

    test('bias@1.3.0 (superseded by 1.4.0, never edited); 1.2.0 carries no minimum', () => {
        expect(['1.3.0', '1.4.0', '1.5.0', '1.6.0']).toContain(latest('bias').version);
        expect(registry('bias', '1.2.0').config.location_min_sample).toBeUndefined();
        const reg = registry('bias', '1.3.0');
        const prev = registry('bias', '1.2.0');
        for (const k of Object.keys(prev.config)) if (k !== 'layer_notes') expect(reg.config[k]).toEqual(prev.config[k]);
    });
});

describe('migration 029 ↔ methodology registry (relevance@1.2.0, P10-13)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const SQL_029 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/029_relevance_word_boundaries.sql'), 'utf8');

    test('029 is exactly the generated relevance@1.2.0 row, idempotent, and edits nothing', () => {
        expect(SQL_029.endsWith(generate(['relevance@1.2.0']))).toBe(true);
        expect((SQL_029.match(/INSERT INTO/g) || []).length).toBe(1);
        expect(SQL_029).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE|DROP/);
    });

    test('relevance@1.2.0 is current; 1.1.0 is unchanged', () => {
        expect(latest('relevance').version).toBe('1.2.0');
        expect(registry('relevance', '1.1.0').config.keywords).toHaveLength(20);
        expect(registry('relevance', '1.2.0').config.keywords).toHaveLength(21);
    });
});

describe('migration 031 ↔ methodology registry (ingest@1.6.0, P10-2)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const { PAYLOAD_TEXT_KEYS, PII_FIELDS } = require('../../../src/pipeline/ingest');
    const SQL_031 = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/031_text_retention.sql'), 'utf8');

    test('031 adds the retention index and ends with exactly the generated ingest@1.6.0 row', () => {
        expect(SQL_031.endsWith(generate(['ingest@1.6.0']))).toBe(true);
        expect(SQL_031).toMatch(/CREATE INDEX IF NOT EXISTS idx_raw_posts_text_live/);
        expect(SQL_031).not.toMatch(/DO UPDATE|UPDATE |DELETE|DROP/);
    });

    test('ingest@1.6.0 registers the payload keys the code no longer stores and every text window', () => {
        const reg = registry('ingest', '1.6.0');
        expect(reg.config.payload_text_keys_not_stored).toEqual([...PAYLOAD_TEXT_KEYS]);
        expect(reg.config.pii_fields_removed).toEqual(PII_FIELDS);
        // Released row: the windows in force when it was registered (the
        // Guardian's 24 h was withdrawn by ingest@1.7.0, migration 055).
        expect(reg.config.text_retention.platform_terms_hours).toEqual({ reddit: 48, guardian: 24, youtube: 720, tiktok: 720 });
        expect(reg.config.privacy_claim).toBe(registry('ingest', '1.5.0').config.privacy_claim);
    });
});

describe('migration 055 ↔ methodology registry (ingest@1.7.0: GUARDIAN ruling and G3)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const SQL_055 = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/055_ingest_retention_rulings.sql'), 'utf8');

    test('055 is exactly the generated ingest@1.7.0 row after its header, and changes no data', () => {
        expect(SQL_055.endsWith(generate(['ingest@1.7.0']))).toBe(true);
        const body = SQL_055.split('\n').filter(l => !l.startsWith('--')).join('\n');
        expect(body).not.toMatch(/DO UPDATE|UPDATE |DELETE|DROP/);
    });

    test('ingest@1.7.0 registers the current platform windows, the Guardian ruling verbatim and G3', () => {
        const reg = registry('ingest', '1.7.0');
        const { SOURCES, retentionHours } = require('../../../src/config/source-registry');
        const platform = Object.fromEntries(SOURCES.filter(s => s.retention).map(s => [s.slug, retentionHours(s)]));
        expect(reg.config.text_retention.platform_terms_hours).toEqual(platform);
        expect(platform).not.toHaveProperty('guardian');
        expect(reg.config.text_retention.rulings.guardian).toMatch(/Jennifer McKinney, 2026-09-29, verbatim "Use normal retention"/);
        expect(reg.config.text_retention.embeddings_on_platform_blanking).toMatch(/deleted with the text.*G3/);
        expect(reg.config.text_retention.applied_by_analogy).toEqual(['youtube', 'tiktok']);
        const prev = registry('ingest', '1.6.0');
        for (const k of Object.keys(prev.config).filter(k => k !== 'text_retention')) expect([k, reg.config[k]]).toEqual([k, prev.config[k]]);
        expect(reg.model_name).toBe(prev.model_name);
    });
});

describe('migration 032 ↔ methodology registry (bias@1.4.0, minimum samples)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const SQL_032 = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/032_bias_sample_rules.sql'), 'utf8');

    test('032 contains exactly the generated bias@1.4.0 row and deletes nothing', () => {
        expect(SQL_032).toContain(generate(['bias@1.4.0']));
        expect((SQL_032.match(/INSERT INTO methodology_versions/g) || []).length).toBe(1);
        expect(SQL_032).not.toMatch(/DO UPDATE|UPDATE methodology_versions|DELETE|DROP|TRUNCATE/);
    });

    test('bias@1.4.0 (superseded by 1.5.0, never edited); every check has a minimum; the SQL uses the registered numbers', () => {
        const reg = registry('bias', '1.4.0');
        expect(['1.4.0', '1.5.0', '1.6.0']).toContain(latest('bias').version);
        expect(reg.config).toMatchObject({ location_min_sample: 30, parity_min_per_category: 10, negative_min_sample: 30 });
        expect(reg.config.sample_rules.basis).toMatch(/n >= 30/);
        expect(SQL_032).toMatch(/p\.n >= 10\b/);
        expect(SQL_032).toMatch(/l\.sample < 30\b/);
        expect(SQL_032).toMatch(/n\.sample < 30\b/);
        expect(registry('bias', '1.3.0').config.parity_min_per_category).toBeUndefined();
    });
});

// PR #22 decision G2: the rolling 24 h window (bias@1.5.0, migration 060).
describe('migration 060 ↔ methodology registry (bias@1.5.0, rolling window)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const SQL_060 = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/060_bias_rolling_window.sql'), 'utf8');

    test('060 ends with exactly the generated bias@1.5.0 row, is additive and deletes nothing', () => {
        expect(SQL_060.endsWith(generate(['bias@1.5.0']))).toBe(true);
        expect((SQL_060.match(/INSERT INTO methodology_versions/g) || []).length).toBe(1);
        expect(SQL_060).not.toMatch(/DO UPDATE|UPDATE [a-z_]+ SET|DELETE FROM|DROP TABLE|TRUNCATE/);
        expect(SQL_060).toMatch(/CREATE TABLE IF NOT EXISTS bias_window_runs/);
        expect(SQL_060).toMatch(/CREATE TABLE IF NOT EXISTS bias_window_assessments/);
        expect(SQL_060).toMatch(/bias_window_assessments_append_only BEFORE UPDATE OR DELETE/);
    });

    test('bias@1.5.0 (superseded by 1.6.0, never edited): bias@1.4.0 plus the 24 h window; every per-cycle rule unchanged', () => {
        expect(['1.5.0', '1.6.0']).toContain(latest('bias').version);
        const reg = registry('bias', '1.5.0');
        const prev = registry('bias', '1.4.0');
        for (const k of Object.keys(prev.config)) expect(reg.config[k]).toEqual(prev.config[k]);
        expect(reg.config.rolling_window).toMatchObject({ hours: 24 });
        expect(reg.config.rolling_window.decision).toMatch(/G2.*Jennifer McKinney 2026-09-29/);
        expect(reg.justification).toMatch(/rolling 24-hour window/);
        expect(reg.model_name).toBe(prev.model_name);
    });
});

// Audit drift D-2: bias@1.6.0 states the parity "insufficient sample" value
// (migration 061), with an erratum on bias@1.4.0 and bias@1.5.0.
describe('migration 061 ↔ methodology registry (bias@1.6.0, parity stated value)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const { METHODOLOGY_ERRATA } = require('../../../src/config/methodology-registry');
    const SQL_061 = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/061_bias_parity_stated_value.sql'), 'utf8');

    test('061 ends with exactly the generated bias@1.6.0 row, is additive and edits nothing', () => {
        expect(SQL_061.endsWith(generate(['bias@1.6.0']))).toBe(true);
        expect((SQL_061.match(/INSERT INTO methodology_versions/g) || []).length).toBe(1);
        expect(SQL_061).not.toMatch(/DO UPDATE|UPDATE [a-z_]+ SET|DELETE FROM|DROP |TRUNCATE/);
    });

    test('061 carries the bias@1.4.0 and bias@1.5.0 errata field for field', () => {
        const errata = METHODOLOGY_ERRATA.filter(e => e.corrected_by === 'bias@1.6.0');
        expect(errata.map(e => `${e.component}@${e.version}`)).toEqual(['bias@1.4.0', 'bias@1.5.0']);
        expect((SQL_061.match(/INSERT INTO methodology_errata/g) || []).length).toBe(2);
        for (const e of errata) {
            expect(SQL_061).toContain(`'${e.erratum_key}', '${e.corrected_by}', $err$${e.erratum}$err$`);
            expect(SQL_061).toContain(`mv.component = '${e.component}' AND mv.version = '${e.version}'`);
        }
    });

    test('bias@1.6.0 is current: bias@1.5.0 plus the stated parity value; every other rule unchanged', () => {
        expect(latest('bias').version).toBe('1.6.0');
        const reg = registry('bias', '1.6.0');
        const prev = registry('bias', '1.5.0');
        for (const k of Object.keys(prev.config)) if (k !== 'sample_rules') expect(reg.config[k]).toEqual(prev.config[k]);
        for (const k of Object.keys(prev.config.sample_rules)) {
            if (k !== 'platform_sentiment_parity') expect(reg.config.sample_rules[k]).toEqual(prev.config.sample_rules[k]);
        }
        expect(reg.config.parity_insufficient_value).toBe('max_diff_all_categories');
        expect(prev.config.parity_insufficient_value).toBeUndefined();
        expect(reg.config.sample_rules.platform_sentiment_parity).toMatch(/largest pairwise gap/);
        expect(reg.config.changelog).toHaveLength(1);
        expect(reg.model_name).toBe(prev.model_name);
    });
});

// Dependabot #29: sentence-transformers 2.7.0 -> 6.1.0 ships as
// embedding@1.1.0 (migration 065), same model and revision, embedding@1.0.0
// never edited. The library pins themselves are tied to the registry by
// tests/unit/pure/embeddingLibraryPins.test.js.
describe('migration 065 ↔ methodology registry (embedding@1.1.0, sentence-transformers 6.1.0)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const { CURRENT_VERSIONS } = require('../../../src/config/methodology-registry');
    const SQL_065 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/065_embedding_sentence_transformers_6.sql'), 'utf8');
    const rows = [...SQL_065.matchAll(ROW_011_RE)].map(m => ({
        component: m[1], version: m[2], model_name: m[3],
        config: JSON.parse(m[4]), justification: m[5],
    }));

    test('065 ends with exactly the generated embedding@1.1.0 row, is additive and edits nothing', () => {
        expect(SQL_065.endsWith(generate(['embedding@1.1.0']))).toBe(true);
        expect(rows.map(r => `${r.component}@${r.version}`)).toEqual(['embedding@1.1.0']);
        expect((SQL_065.match(/INSERT INTO/g) || []).length).toBe(1);
        expect(SQL_065).not.toMatch(/DO UPDATE|UPDATE [a-z_]+ SET|DELETE FROM|DROP |TRUNCATE|ALTER TABLE/);
    });

    test('agrees field for field with the registry entry', () => {
        const reg = registry('embedding', '1.1.0');
        expect(rows[0]).toEqual({
            component: reg.component, version: reg.version, model_name: reg.model_name,
            config: reg.config, justification: reg.justification,
        });
    });

    test('embedding@1.1.0 is current; 1.0.0 is kept as released (012) and precedes it', () => {
        expect(CURRENT_VERSIONS.embedding).toBe('1.1.0');
        expect(latest('embedding').version).toBe('1.1.0');
        const versions = METHODOLOGY_VERSIONS.filter(m => m.component === 'embedding').map(m => m.version);
        expect(versions).toEqual(['1.0.0', '1.1.0']);
        // 012 still inserts the 1.0.0 row exactly as the registry keeps it.
        expect(parse012()[0].config).toEqual(registry('embedding', '1.0.0').config);
        expect(registry('embedding', '1.0.0').config.library).toBe('sentence-transformers==2.7.0');
    });

    test('1.1.0 is 1.0.0 with the new library, its dependencies, the lock and the equivalence evidence', () => {
        const reg = registry('embedding', '1.1.0');
        const prev = registry('embedding', '1.0.0');
        expect(reg.model_name).toBe(prev.model_name);
        for (const k of Object.keys(prev.config)) {
            if (k !== 'library') expect(reg.config[k]).toEqual(prev.config[k]);
        }
        expect(reg.config.library).toBe('sentence-transformers==6.1.0');
        expect(Object.keys(reg.config).filter(k => !(k in prev.config)).sort())
            .toEqual(['changelog', 'equivalence', 'library_dependencies', 'lock']);
        expect(reg.config.equivalence).toMatchObject({ compared_with: expect.stringMatching(/^embedding@1\.0\.0/), texts: 12 });
        expect(reg.config.equivalence.platforms).toEqual(expect.arrayContaining([
            expect.stringMatching(/linux\/arm64/), expect.stringMatching(/linux\/amd64/),
        ]));
        expect(reg.justification).toMatch(/bit-identical/);
        expect(reg.justification).toMatch(/embedding@1\.0\.0 row is kept unedited/);
    });
});

// Content-hash wording (Jennifer McKinney 2026-09-30, "Register new versions
// (Recommended)"): ingest@1.8.0 and audit_narration@1.4.0 (migration 066)
// stop calling the content hash a join key; every released ingest row gets
// an erratum and stays unedited. Wording only.
describe('migration 066 ↔ methodology registry (ingest@1.8.0 + audit_narration@1.4.0, content-hash wording)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const { CURRENT_VERSIONS, METHODOLOGY_ERRATA } = require('../../../src/config/methodology-registry');
    const narration = require('../../../src/config/audit-narration');
    const SQL_066 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/066_content_hash_wording.sql'), 'utf8');
    const rows = [...SQL_066.matchAll(ROW_011_RE)].map(m => ({
        component: m[1], version: m[2], model_name: m[3],
        config: JSON.parse(m[4]), justification: m[5],
    }));
    const OLD_INGEST = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0', '1.7.0'];

    test('066 ends with exactly the generated ingest@1.8.0 and audit_narration@1.4.0 rows, is additive and edits nothing', () => {
        expect(SQL_066.endsWith(generate(['ingest@1.8.0', 'audit_narration@1.4.0']))).toBe(true);
        expect(rows.map(r => `${r.component}@${r.version}`)).toEqual(['ingest@1.8.0', 'audit_narration@1.4.0']);
        expect((SQL_066.match(/INSERT INTO methodology_versions/g) || []).length).toBe(2);
        const body = SQL_066.split('\n').filter(l => !l.startsWith('--')).join('\n');
        expect(body).not.toMatch(/DO UPDATE|UPDATE [a-z_]+ SET|DELETE FROM|DROP |TRUNCATE|ALTER TABLE|CREATE /);
    });

    test.each(['ingest@1.8.0', 'audit_narration@1.4.0'])('%s agrees field for field', (key) => {
        const [component, version] = key.split('@');
        const reg = registry(component, version);
        expect(rows.find(r => r.component === component && r.version === version)).toEqual({
            component: reg.component, version: reg.version, model_name: reg.model_name,
            config: reg.config, justification: reg.justification,
        });
    });

    test('066 carries one erratum per released ingest row, field for field', () => {
        const errata = METHODOLOGY_ERRATA.filter(e => e.corrected_by === 'ingest@1.8.0');
        expect(errata.map(e => `${e.component}@${e.version}`)).toEqual(OLD_INGEST.map(v => `ingest@${v}`));
        expect((SQL_066.match(/INSERT INTO methodology_errata/g) || []).length).toBe(OLD_INGEST.length);
        for (const e of errata) {
            expect(SQL_066).toContain(`'${e.erratum_key}', '${e.corrected_by}', $err$${e.erratum}$err$`);
            expect(SQL_066).toContain(`mv.component = '${e.component}' AND mv.version = '${e.version}'`);
            expect(e.erratum).toMatch(/nothing ran differently/);
            expect(e.erratum).toContain(`The ingest@${e.version} row is kept unedited`);
        }
        expect(new Set(METHODOLOGY_ERRATA.map(e => e.erratum_key)).size).toBe(METHODOLOGY_ERRATA.length);
    });

    test('every released ingest row says "join key" (what the errata correct); 1.8.0 does not', () => {
        for (const v of OLD_INGEST) {
            const r = registry('ingest', v);
            expect(`${r.justification} ${JSON.stringify(r.config)}`).toMatch(/join key/);
        }
        const reg = registry('ingest', '1.8.0');
        expect(reg.config.dedup_strategy).not.toMatch(/join key/);
        expect(reg.config.content_hash).toMatch(/not a join key/);
        expect(reg.config.content_hash).toMatch(/input_hash/);
        expect(reg.justification).toMatch(/^ingest@1\.8\.0 corrects wording only/);
    });

    test('ingest@1.8.0 is current and is 1.7.0 with only the wording keys changed', () => {
        expect(CURRENT_VERSIONS.ingest).toBe('1.8.0');
        expect(latest('ingest').version).toBe('1.8.0');
        const reg = registry('ingest', '1.8.0');
        const prev = registry('ingest', '1.7.0');
        expect(reg.model_name).toBe(prev.model_name);
        for (const k of Object.keys(prev.config)) if (k !== 'dedup_strategy') expect([k, reg.config[k]]).toEqual([k, prev.config[k]]);
        expect(Object.keys(reg.config).filter(k => !(k in prev.config)).sort()).toEqual(['changelog', 'content_hash']);
    });

    // audit_narration@1.4.0 was the renderer's version until migration 067
    // registered 1.5.0 (relevance receipt wording); 1.5.0 keeps its hash note.
    test('audit_narration@1.4.0 registers its hash wording verbatim (the renderer\'s note since)', () => {
        expect(CURRENT_VERSIONS.audit_narration).toBe(narration.NARRATION_VERSION);
        const reg = registry('audit_narration', '1.4.0');
        const prev = registry('audit_narration', '1.3.0');
        expect(reg.model_name).toBe(prev.model_name);
        for (const k of Object.keys(prev.config)) expect([k, reg.config[k]]).toEqual([k, prev.config[k]]);
        expect(reg.config.ingest_hash_note).toBe(narration.INGEST_HASH_NOTE);
        expect(narration.INGEST_HASH_NOTE).toMatch(/not a join key/);
        expect(narration.INGEST_HASH_NOTE).not.toMatch(/immutable join key/);
    });
});

// Relevance-accuracy Stage 0, P0 (Jennifer McKinney 2026-09-30, D1 "Count
// only AI-relevant (Recommended)"): until the aggregation switch ships with
// the Stage-1 lexicon, the relevance receipt must say what is true today —
// every stored post counts toward the totals. audit_narration@1.5.0
// (migration 067) registers that wording; every released audit_narration row
// (1.1.0 to 1.4.0) gets an erratum and stays unedited.
describe('migration 067 ↔ methodology registry (audit_narration@1.5.0, relevance receipt wording)', () => {
    const { generate } = require('../../../scripts/generate-methodology-migration');
    const { CURRENT_VERSIONS, METHODOLOGY_ERRATA } = require('../../../src/config/methodology-registry');
    const narration = require('../../../src/config/audit-narration');
    const SQL_067 = fs.readFileSync(
        path.join(__dirname, '../../../src/db/migrations/067_relevance_receipt_wording.sql'), 'utf8');
    const rows = [...SQL_067.matchAll(ROW_011_RE)].map(m => ({
        component: m[1], version: m[2], model_name: m[3],
        config: JSON.parse(m[4]), justification: m[5],
    }));
    const OLD_NARRATION = ['1.1.0', '1.2.0', '1.3.0', '1.4.0'];

    test('067 ends with exactly the generated audit_narration@1.5.0 row, is additive and edits nothing', () => {
        expect(SQL_067.endsWith(generate(['audit_narration@1.5.0']))).toBe(true);
        expect(rows.map(r => `${r.component}@${r.version}`)).toEqual(['audit_narration@1.5.0']);
        expect((SQL_067.match(/INSERT INTO methodology_versions/g) || []).length).toBe(1);
        const body = SQL_067.split('\n').filter(l => !l.startsWith('--')).join('\n');
        expect(body).not.toMatch(/DO UPDATE|UPDATE [a-z_]+ SET|DELETE FROM|DROP |TRUNCATE|ALTER TABLE|CREATE /);
    });

    test('audit_narration@1.5.0 agrees field for field', () => {
        const reg = registry('audit_narration', '1.5.0');
        expect(rows[0]).toEqual({
            component: reg.component, version: reg.version, model_name: reg.model_name,
            config: reg.config, justification: reg.justification,
        });
    });

    test('audit_narration@1.5.0 is current, is 1.4.0 plus the relevance wording, and registers it verbatim', () => {
        expect(CURRENT_VERSIONS.audit_narration).toBe('1.5.0');
        expect(narration.NARRATION_VERSION).toBe('1.5.0');
        expect(latest('audit_narration').version).toBe('1.5.0');
        const reg = registry('audit_narration', '1.5.0');
        const prev = registry('audit_narration', '1.4.0');
        expect(reg.model_name).toBe(prev.model_name);
        for (const k of Object.keys(prev.config)) if (k !== 'changelog') expect([k, reg.config[k]]).toEqual([k, prev.config[k]]);
        expect(Object.keys(reg.config).filter(k => !(k in prev.config))).toEqual(['relevance_public']);
        expect(reg.config.relevance_public).toEqual(narration.RELEVANCE_PUBLIC);
        expect(reg.config.changelog).toEqual([expect.stringMatching(/^audit_narration@1\.5\.0 \(2026-09-30\): /)]);
        expect(reg.justification).toMatch(/does not count toward AI-discourse totals/);
        expect(reg.justification).toMatch(/every stored post counts toward the totals/);
    });

    test('067 carries one erratum per released audit_narration row, field for field', () => {
        const errata = METHODOLOGY_ERRATA.filter(e => e.corrected_by === 'audit_narration@1.5.0');
        expect(errata.map(e => `${e.component}@${e.version}`)).toEqual(OLD_NARRATION.map(v => `audit_narration@${v}`));
        expect((SQL_067.match(/INSERT INTO methodology_errata/g) || []).length).toBe(OLD_NARRATION.length);
        for (const e of errata) {
            expect(SQL_067).toContain(`'${e.erratum_key}', '${e.corrected_by}', $err$${e.erratum}$err$`);
            expect(SQL_067).toContain(`mv.component = '${e.component}' AND mv.version = '${e.version}'`);
            expect(e.erratum_key).toBe(`audit_narration-${e.version}-relevance-totals-wording`);
            expect(e.erratum).toMatch(/does not count toward AI-discourse totals/);
            expect(e.erratum).toMatch(/counted toward every total/);
            expect(e.erratum).toContain(`The audit_narration@${e.version} row is kept unedited`);
            expect(e.erratum).not.toMatch(/\$err\$/);
        }
        expect(new Set(METHODOLOGY_ERRATA.map(e => e.erratum_key)).size).toBe(METHODOLOGY_ERRATA.length);
    });
});
