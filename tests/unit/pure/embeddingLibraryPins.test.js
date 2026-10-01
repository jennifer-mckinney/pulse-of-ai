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
// must all pin exactly the registered versions. torch is pinned per platform
// in requirements.txt (the +cpu build where it exists, from the PyTorch CPU
// index; the plain build of the same release on macOS, which has no +cpu
// wheel), and CI's Python 3.11 job also installs it first from
// .github/workflows/ci.yml TORCH_VERSION, checked here too.
//
// Two general drift checks sit beside the methodology ones:
//   - every exact pin of requirements-service.in is the version the lock
//     installs (an .in edit without a lock refresh fails), and
//   - every requirements.txt requirement on a package the lock installs must
//     admit the locked version. Dependabot bumps the dev floors but never the
//     hand-refreshed lock, so a floor that overtakes the image (once:
//     fastapi>=0.141.1 against a locked 0.139.0) fails here instead of going
//     unnoticed.

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

/** The environment marker of a requirement line ('; sys_platform == "darwin"'), whitespace-normalised, or null. */
function markerOf(line) {
    const i = line.indexOf(';');
    if (i < 0) return null;
    const marker = line.slice(i + 1).replace(/\\$/, '').trim().replace(/\s+/g, ' ');
    return marker || null;
}

/**
 * Every `name==version` pin of a requirements file, keyed by normalised
 * name. Comments, option lines (--hash, --extra-index-url) and `>=` ranges
 * are ignored; a name pinned twice is an error (it would make the lookup
 * ambiguous). A pin with an environment marker is keyed `name ; marker`, so
 * per-platform pins of one package (torch in requirements.txt) stay apart
 * and never answer the unconditional lookup.
 * @param {string} text
 * @returns {Map<string, string>}
 */
function exactPins(text) {
    const pins = new Map();
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        const m = line.match(PIN_RE);
        if (!m) continue;
        const marker = markerOf(line);
        const key = marker ? `${norm(m[1])} ; ${marker}` : norm(m[1]);
        if (pins.has(key)) throw new Error(`${key} pinned twice`);
        pins.set(key, m[2]);
    }
    return pins;
}

// A requirement line: name, optional [extras], optional specifier list,
// optional `; marker`. Option lines (-r, --hash, --extra-index-url) start
// with '-' and are skipped.
const REQ_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;]*)/;
const SPEC_RE = /^(===|==|!=|~=|>=|<=|>|<)\s*(\S+)$/;
// PEP 440 public version (release, pre, post, dev) plus an optional local
// label. Anything else is refused rather than compared wrongly.
const VERSION_RE = /^v?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|rc)(\d+))?(?:[-_.]?post(\d+))?(?:[-_.]?dev(\d+))?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i;
const PRE_RANK = { a: -3, b: -2, rc: -1 };

/**
 * Every requirement of a requirements file, keyed by normalised name: one
 * entry per line, each with its environment marker (null = every platform)
 * and specifier list (empty = any version). A name may appear on several
 * lines only when every one of them carries a different marker (per-platform
 * pins); any other repeat is an error, as in exactPins.
 * @param {string} text
 * @returns {Map<string, Array<{marker: (string|null), specs: Array<{op: string, version: string}>}>>}
 */
function requirementSpecs(text) {
    const reqs = new Map();
    for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').replace(/\\$/, '').trim();
        if (!line || line.startsWith('-')) continue;
        const m = line.match(REQ_RE);
        if (!m) continue;
        const key = norm(m[1]);
        const marker = markerOf(line);
        const entries = reqs.get(key) || [];
        if (entries.length && (marker === null || entries.some(e => e.marker === null || e.marker === marker))) {
            throw new Error(`${key} listed twice`);
        }
        const specs = m[2].split(',').map(x => x.trim()).filter(Boolean).map(spec => {
            const sm = spec.match(SPEC_RE);
            if (!sm) throw new Error(`${key}: unsupported specifier "${spec}"`);
            if (sm[2].includes('*')) throw new Error(`${key}: wildcard specifier "${spec}" is not supported`);
            parseVersion(sm[2]);
            return { op: sm[1], version: sm[2] };
        });
        entries.push({ marker, specs });
        reqs.set(key, entries);
    }
    return reqs;
}

/**
 * '2.12.1+cpu' → { release: [2, 12, 1], pre, preN, post, dev, local: 'cpu' },
 * ranked so that X.devN < XaN < XbN < XrcN < X < X.postN.
 */
function parseVersion(v) {
    const m = String(v).match(VERSION_RE);
    if (!m) throw new Error(`not a PEP 440 version: ${v}`);
    const devOnly = m[5] !== undefined && m[2] === undefined && m[4] === undefined;
    return {
        release: m[1].split('.').map(Number),
        pre:   m[2] ? PRE_RANK[m[2].toLowerCase()] : (devOnly ? -4 : 0),
        preN:  m[3] === undefined ? 0 : Number(m[3]),
        post:  m[4] === undefined ? -1 : Number(m[4]),
        dev:   m[5] === undefined ? Infinity : Number(m[5]),
        // PEP 440 local-label normalisation: '-', '_' and '.' are the same
        // separator, letters compare case-insensitively and numeric segments
        // as integers ('cpu_01' and 'CPU.1' are equal).
        local: m[6] === undefined ? null : m[6].split(/[-_.]/)
            .map(seg => (/^\d+$/.test(seg) ? String(Number(seg)) : seg.toLowerCase())).join('.'),
    };
}

const isPreRelease = v => v.pre !== 0 || v.dev !== Infinity;
const isPostRelease = v => v.post !== -1;
/** Same release segments, zero-padded ('2.0' and '2.0.0' are one release). */
function sameRelease(a, b) {
    const n = Math.max(a.release.length, b.release.length);
    for (let i = 0; i < n; i++) if ((a.release[i] || 0) !== (b.release[i] || 0)) return false;
    return true;
}

/** Compare two versions, local labels ignored: <0, 0 or >0. */
function compareVersions(a, b) {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    const n = Math.max(va.release.length, vb.release.length);
    for (let i = 0; i < n; i++) {
        const d = (va.release[i] || 0) - (vb.release[i] || 0);
        if (d) return d;
    }
    for (const k of ['pre', 'preN', 'post', 'dev']) {
        if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
    }
    return 0;
}

/**
 * Whether one specifier admits a concrete version, by the PEP 440 rules pip
 * applies: the candidate's local label (+cpu) is ignored unless the
 * specifier names one, `<V` excludes pre-releases of V's release unless V is
 * itself a pre-release, and `>V` excludes post-releases and local versions of
 * V's release unless V is itself a post-release.
 * @param {{op: string, version: string}} spec
 * @param {string} candidate
 * @returns {boolean}
 */
function admits({ op, version }, candidate) {
    if (op === '===') return candidate.toLowerCase() === version.toLowerCase();
    const spec = parseVersion(version);
    const cand = parseVersion(candidate);
    const c = compareVersions(candidate, version);
    if ((op === '==' || op === '!=') && spec.local !== null) {
        const same = c === 0 && cand.local === spec.local;
        return op === '==' ? same : !same;
    }
    switch (op) {
        case '==': return c === 0;
        case '!=': return c !== 0;
        case '>=': return c >= 0;
        case '<=': return c <= 0;
        case '>':
            // A local version of V compares equal to V (c === 0), so it is
            // already refused here; post-releases of V's release need the rule.
            if (c <= 0) return false;
            return !(!isPostRelease(spec) && isPostRelease(cand) && sameRelease(cand, spec));
        case '<':
            if (c >= 0) return false;
            return !(!isPreRelease(spec) && isPreRelease(cand) && sameRelease(cand, spec));
        case '~=': {
            // ~=X.Y.Z means >=X.Y.Z together with ==X.Y.*
            if (spec.release.length < 2) throw new Error(`~=${version} needs at least two release segments`);
            const cand = parseVersion(candidate).release;
            return c >= 0 && spec.release.slice(0, -1).every((seg, i) => (cand[i] || 0) === seg);
        }
        default: throw new Error(`unsupported operator ${op}`);
    }
}

/**
 * Every requirement line whose package the lock installs at a version the
 * line does not admit. Each per-platform line is checked on its own.
 * @param {ReturnType<typeof requirementSpecs>} reqs
 * @param {Map<string, string>} lockPins
 * @returns {string[]} e.g. ['fastapi>=0.141.1 excludes the locked 0.139.0']
 */
function lockDrift(reqs, lockPins) {
    const out = [];
    for (const [name, entries] of reqs) {
        const locked = lockPins.get(name);
        if (locked === undefined) continue;
        for (const { marker, specs } of entries) {
            if (specs.some(s => !admits(s, locked))) {
                const where = marker ? ` ; ${marker}` : '';
                out.push(`${name}${specs.map(s => s.op + s.version).join(',')}${where} excludes the locked ${locked}`);
            }
        }
    }
    return out;
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
const DEV_REQS = requirementSpecs(read(FILES.requirements));

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

    test.each(Object.keys(current.config.library_dependencies).filter(dep => dep !== 'torch'))(
        'dependency %s: python/requirements.txt pins the registered version exactly', (dep) => {
            const version = current.config.library_dependencies[dep];
            expect(DEV_REQS.get(norm(dep))).toEqual([{ marker: null, specs: [{ op: '==', version }] }]);
        });

    // torch has two builds of one release: the registered +cpu build exists
    // for Linux and Windows on the PyTorch CPU index only, and macOS has just
    // the plain build (CPU/MPS, no +cpu wheel anywhere). requirements.txt pins
    // each platform exactly instead of leaving torch to whatever pip resolves
    // (Copilot, PR #41: an unpinned torch in the README install path would
    // let host vectors claim embedding@1.1.0 on an unregistered build).
    test('dependency torch: python/requirements.txt pins the registered build on every platform that has it', () => {
        const registered = current.config.library_dependencies.torch;
        expect(registered).toMatch(/^\d+(\.\d+)*\+cpu$/);
        expect(DEV_REQS.get('torch')).toEqual([
            { marker: 'sys_platform != "darwin"', specs: [{ op: '==', version: registered }] },
            { marker: 'sys_platform == "darwin"', specs: [{ op: '==', version: registered.replace(/\+cpu$/, '') }] },
        ]);
    });

    test('python/requirements.txt reads the PyTorch CPU index, the same one as the image lock', () => {
        const INDEX = /^--extra-index-url\s+(\S+)\s*$/m;
        const devIndex = read(FILES.requirements).match(INDEX);
        expect(devIndex).not.toBeNull();
        expect(devIndex[1]).toBe('https://download.pytorch.org/whl/cpu');
        expect(read(FILES.serviceLock).match(INDEX)[1]).toBe(devIndex[1]);
    });

    test('the Python suite expects the registered torch build (REGISTERED_TORCH)', () => {
        const m = read('python/tests/test_embeddings.py').match(/^REGISTERED_TORCH = "([^"]+)"$/m);
        expect(m).not.toBeNull();
        expect(m[1]).toBe(current.config.library_dependencies.torch);
    });

    test('the Python suite expects /health to report the registered library (REGISTERED_LIBRARY)', () => {
        const m = read('python/tests/test_embeddings.py').match(/^REGISTERED_LIBRARY = "([^"]+)"$/m);
        expect(m).not.toBeNull();
        expect(m[1]).toBe(current.config.library);
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

describe('service .in ↔ hash lock ↔ dev requirements', () => {
    test('every exact pin of requirements-service.in is the version the lock installs', () => {
        const drift = [...PINS.serviceIn]
            .filter(([name, version]) => PINS.serviceLock.get(name) !== version)
            .map(([name, version]) => `${name}: .in ${version}, lock ${PINS.serviceLock.get(name)}`);
        expect(drift).toEqual([]);
    });

    test('every requirements.txt requirement on a locked package admits the locked version', () => {
        expect(lockDrift(DEV_REQS, PINS.serviceLock)).toEqual([]);
    });

    test('the check is not vacuous: server, library stack and test client are all compared', () => {
        const compared = [...DEV_REQS.keys()].filter(name => PINS.serviceLock.has(name));
        expect(compared).toEqual(expect.arrayContaining([
            'fastapi', 'uvicorn', 'httpx',
            'sentence-transformers', 'transformers', 'huggingface-hub', 'tokenizers', 'torch',
        ]));
    });
});

describe('lockDrift / admits / requirementSpecs (the comparison the drift check relies on)', () => {
    test('flags a dev floor above the locked version (the fastapi / uvicorn state before this fix)', () => {
        const lock = exactPins([
            'fastapi==0.139.0 \\',
            '    --hash=sha256:aa',
            'uvicorn==0.50.0',
            'starlette==1.7.0',
        ].join('\n'));
        const reqs = requirementSpecs('fastapi>=0.141.1\nuvicorn>=0.54.0\nstarlette>=1.0,<2\npytest>=9.1.1\n');
        expect(lockDrift(reqs, lock)).toEqual([
            'fastapi>=0.141.1 excludes the locked 0.139.0',
            'uvicorn>=0.54.0 excludes the locked 0.50.0',
        ]);
    });

    test('accepts floors at or below the lock and ignores packages the lock does not install', () => {
        const lock = exactPins('fastapi==0.141.1\nuvicorn==0.54.0\n');
        expect(lockDrift(requirementSpecs('fastapi>=0.141.1\nuvicorn>=0.50\nblack>=99\n'), lock)).toEqual([]);
    });

    test.each([
        ['>=', '0.141.1', '0.141.1', true],
        ['>=', '0.141.1', '0.141.0', false],
        ['>=', '0.141.1', '0.142', true],
        ['>=', '0.54.0', '0.100.0', true],
        ['>',  '1.0', '1.0.0', false],
        ['<',  '2', '1.99.99', true],
        ['<=', '1.0', '1.0.post1', false],
        ['==', '5.18.0', '5.18', true],
        ['==', '5.18.0', '5.18.1', false],
        ['!=', '5.18.0', '5.18.1', true],
        ['~=', '1.33.0', '1.33.9', true],
        ['~=', '1.33.0', '1.34.0', false],
        ['~=', '1.33', '1.99', true],
        ['~=', '1.33', '2.0', false],
        ['==', '2.12.1', '2.12.1+cpu', true],
        ['==', '2.12.1+cpu', '2.12.1+cpu', true],
        ['==', '2.12.1+cpu', '2.12.1', false],
        ['>=', '2.0', '2.0rc1', false],
        ['>=', '2.0rc1', '2.0', true],
        ['<',  '2.0a1', '2.0.dev3', true],
        // Exclusive bounds (PEP 440): `<V` refuses pre-releases of V unless V
        // is one; `>V` refuses post-releases and local versions of V unless
        // V is a post-release.
        ['<',  '2.0', '2.0rc1', false],
        ['<',  '2.0', '2.0.dev1', false],
        ['<',  '2.0', '1.9', true],
        ['<',  '2.0rc2', '2.0rc1', true],
        ['<',  '2.0', '2.0.0a1', false],
        ['>',  '1.0', '1.0.post1', false],
        ['>',  '1.0', '1.0.0.post2', false],
        ['>',  '1.0', '1.0+cpu', false],
        ['>',  '1.0', '1.0.1', true],
        ['>',  '1.0.post1', '1.0.post2', true],
        ['>=', '1.0', '1.0.post1', true],
        // Local labels normalise separators, case and numeric segments.
        ['==', '1.0+cpu_1', '1.0+cpu-1', true],
        ['==', '1.0+CPU.01', '1.0+cpu_1', true],
        ['==', '1.0+cpu.1', '1.0+cpu.2', false],
        ['!=', '1.0+cpu-1', '1.0+cpu.1', false],
        ['===', '1.0', '1.0', true],
        ['===', 'Foo-1.0', 'foo-1.0', true],
        ['===', '1.0', '1.0.0', false],
    ])('%s%s admits %s: %s', (op, version, candidate, expected) => {
        expect(admits({ op, version }, candidate)).toBe(expected);
    });

    test('reads specifier lists, extras and markers; skips options, continuations and comments', () => {
        const reqs = requirementSpecs([
            '# fastapi==0.1',
            '--extra-index-url https://download.pytorch.org/whl/cpu',
            'uvicorn[standard]>=0.54.0, <1 ; python_version >= "3.11"',
            'httpx>=0.28.1         # async HTTP client',
            'Huggingface_Hub==1.33.0 \\',
            '    --hash=sha256:abc',
            'pytest',
        ].join('\n'));
        expect([...reqs]).toEqual([
            ['uvicorn', [{ marker: 'python_version >= "3.11"', specs: [{ op: '>=', version: '0.54.0' }, { op: '<', version: '1' }] }]],
            ['httpx', [{ marker: null, specs: [{ op: '>=', version: '0.28.1' }] }]],
            ['huggingface-hub', [{ marker: null, specs: [{ op: '==', version: '1.33.0' }] }]],
            ['pytest', [{ marker: null, specs: [] }]],
        ]);
    });

    test('keeps per-platform lines of one package apart and checks each against the lock', () => {
        const reqs = requirementSpecs([
            'torch==2.12.1+cpu ; sys_platform != "darwin"',
            'torch==2.12.1 ;  sys_platform  ==  "darwin"',
        ].join('\n'));
        expect(reqs.get('torch')).toEqual([
            { marker: 'sys_platform != "darwin"', specs: [{ op: '==', version: '2.12.1+cpu' }] },
            { marker: 'sys_platform == "darwin"', specs: [{ op: '==', version: '2.12.1' }] },
        ]);
        // The plain macOS pin admits the locked +cpu build (local labels are
        // ignored by a public pin); a different release on either line is drift.
        expect(lockDrift(reqs, exactPins('torch==2.12.1+cpu\n'))).toEqual([]);
        expect(lockDrift(requirementSpecs('torch==2.13.0 ; sys_platform == "darwin"\n'), exactPins('torch==2.12.1+cpu\n')))
            .toEqual(['torch==2.13.0 ; sys_platform == "darwin" excludes the locked 2.12.1+cpu']);
    });

    test('refuses what it cannot compare correctly instead of guessing', () => {
        expect(() => requirementSpecs('fastapi==0.141.*\n')).toThrow(/wildcard/);
        expect(() => requirementSpecs('fastapi=0.1\n')).toThrow(/unsupported specifier/);
        expect(() => requirementSpecs('fastapi>=latest\n')).toThrow(/not a PEP 440 version/);
        expect(() => requirementSpecs('a>=1\nA>=2\n')).toThrow(/a listed twice/);
        // A repeat is only allowed as per-platform lines with distinct markers.
        expect(() => requirementSpecs('a==1 ; sys_platform == "linux"\na==2\n')).toThrow(/a listed twice/);
        expect(() => requirementSpecs('a==1\na==2 ; sys_platform == "linux"\n')).toThrow(/a listed twice/);
        expect(() => requirementSpecs('a==1 ; os_name == "nt"\na==2 ; os_name == "nt"\n')).toThrow(/a listed twice/);
        expect(() => admits({ op: '~=', version: '1' }, '1.5')).toThrow(/two release segments/);
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

    test('keys a pin with a marker by name and marker, so it never answers the plain lookup', () => {
        const pins = exactPins('torch==2.12.1+cpu ; sys_platform != "darwin"\ntorch==2.12.1 ; sys_platform == "darwin"\n');
        expect(pins.get('torch')).toBeUndefined();
        expect([...pins]).toEqual([
            ['torch ; sys_platform != "darwin"', '2.12.1+cpu'],
            ['torch ; sys_platform == "darwin"', '2.12.1'],
        ]);
    });

    test('splitLibrary refuses a library string that is not an exact pin', () => {
        expect(() => splitLibrary('sentence-transformers>=6')).toThrow(/not "name==version"/);
        expect(splitLibrary('Sentence_Transformers==6.1.0')).toEqual(['sentence-transformers', '6.1.0']);
    });
});
