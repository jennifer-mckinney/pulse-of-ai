// tests/unit/pure/embeddingLibraryPins.test.js
// The CURRENT embedding methodology row names the library that produces the
// stored vectors (config.library, e.g. 'sentence-transformers==6.1.0') and the
// transformers / huggingface_hub / tokenizers / torch versions it runs on
// (config.library_dependencies). Those are methodology: a library bump can
// change vectors, so it ships as a NEW embedding version with evidence
// (embedding@1.1.0, migration 065, Dependabot #29).
//
// Until now nothing tied the registry to the requirement files, so a pin
// could move (Dependabot, a hand edit) while every new vector kept claiming
// the old library. These tests fail on any such drift, in either direction:
//   - python/requirements.txt           (dev/test toolchain, CI Python 3.11)
//   - python/requirements-service.in    (top-level pins of the image)
//   - python/requirements-service.txt   (the hash lock the image installs)
// must all pin exactly the registered versions, and CI's Python 3.11 job
// (.github/workflows/ci.yml TORCH_VERSION) installs the registered torch.

'use strict';

const fs = require('fs');
const path = require('path');
const { METHODOLOGY_VERSIONS, CURRENT_VERSIONS } = require('../../../src/config/methodology-registry');

const ROOT = path.join(__dirname, '../../..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// PEP 503 name normalisation: huggingface_hub == huggingface-hub.
const norm = name => name.toLowerCase().replace(/[-_.]+/g, '-');

const PIN_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\;]+)/;
const LIBRARY_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)$/;

/**
 * Every `name==version` pin of a requirements file, keyed by normalised
 * name. Comments, option lines (--hash, --extra-index-url) and `>=` ranges
 * are ignored; a name pinned twice is an error (it would make the lookup
 * ambiguous).
 * @param {string} text
 * @returns {Map<string, string>}
 */
function exactPins(text) {
    const pins = new Map();
    for (const raw of text.split('\n')) {
        const m = raw.replace(/#.*$/, '').trim().match(PIN_RE);
        if (!m) continue;
        const key = norm(m[1]);
        if (pins.has(key)) throw new Error(`${key} pinned twice`);
        pins.set(key, m[2]);
    }
    return pins;
}

/** 'sentence-transformers==6.1.0' → ['sentence-transformers', '6.1.0'] */
function splitLibrary(library) {
    const m = String(library).match(LIBRARY_RE);
    if (!m) throw new Error(`embedding config.library is not "name==version": ${library}`);
    return [norm(m[1]), m[2]];
}

const FILES = {
    requirements: 'python/requirements.txt',
    serviceIn:    'python/requirements-service.in',
    serviceLock:  'python/requirements-service.txt',
};
const PINS = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, exactPins(read(rel))]));

const embeddingRow = version => METHODOLOGY_VERSIONS.find(m => m.component === 'embedding' && m.version === version);
const current = embeddingRow(CURRENT_VERSIONS.embedding);

describe('embedding methodology library ↔ requirement pins', () => {
    test('the current embedding version is embedding@1.1.0 (sentence-transformers 6.1.0)', () => {
        expect(CURRENT_VERSIONS.embedding).toBe('1.1.0');
        expect(current.config.library).toBe('sentence-transformers==6.1.0');
    });

    test.each(Object.keys(FILES))('%s pins the registered library version exactly', (file) => {
        const [name, version] = splitLibrary(current.config.library);
        expect(PINS[file].get(name)).toBe(version);
    });

    test.each(Object.keys(current.config.library_dependencies))(
        'dependency %s: the service .in and the hash lock pin the registered version', (dep) => {
            const version = current.config.library_dependencies[dep];
            expect(PINS.serviceIn.get(norm(dep))).toBe(version);
            expect(PINS.serviceLock.get(norm(dep))).toBe(version);
        });

    test('CI\'s Python 3.11 job installs the registered torch build (ci.yml TORCH_VERSION)', () => {
        const m = read('.github/workflows/ci.yml').match(/^\s*TORCH_VERSION:\s*(\S+)\s*$/m);
        expect(m).not.toBeNull();
        expect(m[1]).toBe(current.config.library_dependencies.torch);
    });

    test('the registered dependencies cover every library the vectors depend on', () => {
        expect(Object.keys(current.config.library_dependencies).sort())
            .toEqual(['huggingface_hub', 'tokenizers', 'torch', 'transformers']);
    });

    test('the released embedding@1.0.0 row still names the library it ran on (never edited)', () => {
        const v100 = embeddingRow('1.0.0');
        expect(v100.config.library).toBe('sentence-transformers==2.7.0');
        expect(v100.config.library_dependencies).toBeUndefined();
        // …and it is no longer what the files pin, which is why 1.1.0 exists.
        expect(PINS.serviceIn.get('sentence-transformers')).not.toBe('2.7.0');
    });

    test('1.1.0 changes only the library: same model, revision, dimensions and normalisation as 1.0.0', () => {
        const v100 = embeddingRow('1.0.0');
        expect(current.model_name).toBe(v100.model_name);
        for (const k of ['revision', 'dimensions', 'normalize_embeddings', 'service', 'revision_env']) {
            expect(current.config[k]).toEqual(v100.config[k]);
        }
    });
});

describe('exactPins (the parser the drift check relies on)', () => {
    test('reads name==version pins, normalises names, skips comments, options, hashes and ranges', () => {
        const pins = exactPins([
            '# a comment sentence-transformers==9.9.9',
            '--extra-index-url https://download.pytorch.org/whl/cpu',
            'torch==2.12.1+cpu \\',
            '    --hash=sha256:abc',
            'huggingface_hub==1.33.0',
            'fastapi>=0.110.0',
            'tokenizers==0.23.2   # trailing comment',
        ].join('\n'));
        expect([...pins]).toEqual([
            ['torch', '2.12.1+cpu'], ['huggingface-hub', '1.33.0'], ['tokenizers', '0.23.2'],
        ]);
    });

    test('refuses a package pinned twice', () => {
        expect(() => exactPins('a==1\nA==2\n')).toThrow(/a pinned twice/);
    });

    test('splitLibrary refuses a library string that is not an exact pin', () => {
        expect(() => splitLibrary('sentence-transformers>=6')).toThrow(/not "name==version"/);
        expect(splitLibrary('Sentence_Transformers==6.1.0')).toEqual(['sentence-transformers', '6.1.0']);
    });
});
