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

const registry = (component) => METHODOLOGY_VERSIONS.find(m => m.component === component);

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
        const reg = registry(component);
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

    test('the audit_narration row matches the renderer version and the real replay command', () => {
        const narr = rows.find(r => r.component === 'audit_narration');
        expect(narr.component).toBe(NARRATION_COMPONENT);
        expect(narr.version).toBe(NARRATION_VERSION);
        expect(narr.config.reproduce_command).toBe(REPRODUCE_COMMAND);
        expect(REPRODUCE_COMMAND).toBe('npm run replay -- --post {post_id}');
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
