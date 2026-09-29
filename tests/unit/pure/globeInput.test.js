// tests/unit/pure/globeInput.test.js
// Regression tests for two PR #8 grumpy-review fixes in public/js/globe.js:
//   #2    — the window keydown zoom handler (onKey) ignores ctrl/cmd/alt
//           chords (browser page zoom) and every key while the globe is not
//           interactive (story mode), and the '0' reset holds the auto-spin
//           for GLOBE.idleResumeMs exactly like zoomBy does.
//   NIT b — setState warns (console.warn) on an unknown prop name and stays
//           silent for known ones.
//
// The globe's view state (st.userZoom / st.userUntil) is private, so these
// tests observe it through the render loop instead: a recording 2D context
// captures ctx.arc() calls, where the sphere body's radius is R (∝ zoom) and
// one city marker's x position moves only while the globe auto-spins. The
// clock (performance.now), requestAnimationFrame, ResizeObserver, fetch and
// window are stubbed — no jsdom, no real canvas.

'use strict';

const globe = require('../../../public/js/globe');
const { GLOBE } = require('../../../public/js/config/design.config');

// ── Harness ─────────────────────────────────────────────────────────────────

let clock;          // the stubbed performance.now() value
let rafCb;          // the frame callback most recently scheduled
let winListeners;   // window event listeners by type (keydown lives here)
let arcs;           // ctx.arc(...) argument lists recorded this frame
let nowSpy;
let instances;

// Recording 2D context: arc() is captured; every other method is a no-op
// that returns the proxy (so createRadialGradient(...).addColorStop works);
// property writes (fillStyle, globalAlpha, …) are simply stored.
function makeCtx() {
    const target = {};
    const proxy = new Proxy(target, {
        get(t, prop) {
            if (prop === 'arc') return (...args) => { arcs.push(args); };
            if (prop in t) return t[prop];
            return () => proxy;
        },
        set(t, prop, value) {
            t[prop] = value;
            return true;
        },
    });
    return proxy;
}

function makeCanvas() {
    const ctx = makeCtx();
    return {
        tagName: 'CANVAS',
        style: {},
        clientWidth: 200,
        clientHeight: 200,
        width: 0,
        height: 0,
        parentNode: null,
        getContext: () => ctx,
        addEventListener() {},
        removeEventListener() {},
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
}

// One city on the equator at the rest longitude (20°), so its marker sits
// front-centre where its screen x is most sensitive to the view rotation.
const CITIES = [{
    id: 'front', name: 'Front', lat: 0, lon: 20,
    total: 10, positive: 5, neutral: 3, negative: 2,
}];

function makeGlobe(props) {
    const g = globe.create(makeCanvas());
    instances.push(g);
    g.setState(Object.assign({ cities: CITIES }, props || {}));
    return g;
}

// step(t): run exactly one render frame at time t and report the sphere
// radius R (arc #0 is the sphere body at radius R) and the city marker's x
// (arc #2 is the city's glow halo, centred on the marker).
function step(t) {
    clock = t;
    arcs = [];
    const cb = rafCb;
    cb(t);
    return { R: arcs[0][2], cityX: arcs[2] ? arcs[2][0] : null };
}

// Run n frames spaced 50 ms apart starting after t0; returns the last probe.
function run(t0, n) {
    let probe = null;
    for (let i = 1; i <= n; i++) probe = step(t0 + i * 50);
    return probe;
}

function key(k, mods) {
    const e = Object.assign({
        key: k,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        target: { tagName: 'BODY' },
        preventDefault: jest.fn(),
    }, mods || {});
    winListeners.keydown(e);
    return e;
}

beforeAll(() => {
    global.window = {
        addEventListener(type, fn) { winListeners[type] = fn; },
        removeEventListener(type) { delete winListeners[type]; },
        devicePixelRatio: 1,
    };
    global.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
    global.cancelAnimationFrame = () => {};
    global.ResizeObserver = class { observe() {} disconnect() {} };
    // Land geometry never arrives: no land dots are drawn, which keeps the
    // arc() record down to the sphere body/rim plus the one city.
    global.fetch = () => new Promise(() => {});
});

afterAll(() => {
    delete global.window;
    delete global.requestAnimationFrame;
    delete global.cancelAnimationFrame;
    delete global.ResizeObserver;
    delete global.fetch;
});

beforeEach(() => {
    winListeners = {};
    instances = [];
    rafCb = null;
    clock = 1000;
    nowSpy = jest.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
    instances.forEach((g) => g.destroy());
    nowSpy.mockRestore();
});

// ── #2 keyboard zoom guards ─────────────────────────────────────────────────

describe('PulseGlobe keyboard zoom (grumpy #2)', () => {
    test('control: plain + in explore (interactive) mode zooms and preventDefaults', () => {
        makeGlobe({ interactive: true });
        const base = step(1000).R;
        const e = key('+');
        expect(e.preventDefault).toHaveBeenCalledTimes(1);
        expect(run(1000, 40).R).toBeGreaterThan(base);
    });

    test.each([
        ['ctrlKey', '+'], ['ctrlKey', '-'],
        ['metaKey', '+'], ['metaKey', '-'],
        ['altKey', '+'], ['altKey', '-'],
    ])('%s + "%s" is left to the browser: no preventDefault, no zoom', (mod, k) => {
        makeGlobe({ interactive: true });
        const base = step(1000).R;
        const e = key(k, { [mod]: true });
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(run(1000, 40).R).toBe(base);
    });

    test.each(['+', '-', '=', '_'])(
        'story mode (not interactive): "%s" is ignored — no preventDefault, no zoom', (k) => {
            makeGlobe({ interactive: false });
            const base = step(1000).R;
            const e = key(k);
            expect(e.preventDefault).not.toHaveBeenCalled();
            expect(run(1000, 40).R).toBe(base);
        });

    test('"0" reset holds the auto-spin for idleResumeMs (userUntil), then spin resumes', () => {
        makeGlobe({ interactive: true });
        step(1000);
        // Control: an idle interactive globe auto-spins, so the marker moves.
        const a = step(1050).cityX;
        const b = step(1100).cityX;
        expect(b).not.toBe(a);

        clock = 1100;
        key('0');
        // Held: rotation targets the current view, so the marker is frozen.
        const h1 = step(1150).cityX;
        const h2 = step(1200).cityX;
        const h3 = step(1100 + GLOBE.idleResumeMs - 50).cityX;
        expect(h2).toBe(h1);
        expect(h3).toBe(h1);

        // Past the hold window the auto-spin takes over again.
        const r1 = step(1100 + GLOBE.idleResumeMs + 50).cityX;
        const r2 = step(1100 + GLOBE.idleResumeMs + 100).cityX;
        expect(r2).not.toBe(r1);
    });

    test('"0" resets a keyboard zoom back to the base radius', () => {
        makeGlobe({ interactive: true });
        const base = step(1000).R;
        key('+');
        key('+');
        const zoomed = run(1000, 60).R;
        expect(zoomed).toBeGreaterThan(base);
        clock = 4000;
        key('0');
        const reset = run(4000, 400).R;
        expect(reset).toBeCloseTo(base, 3);
    });
});

// ── NIT b: setState warns on unknown props ──────────────────────────────────

describe('PulseGlobe.setState unknown-prop warning (grumpy NIT b)', () => {
    let warnSpy;
    beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => warnSpy.mockRestore());

    test('an unknown key warns (naming the key) and is not stored', () => {
        const g = makeGlobe();
        warnSpy.mockClear();
        g.setState({ selectedID: 'front' });   // typo of selectedId
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('"selectedID"');
        expect(g.getState()).not.toHaveProperty('selectedID');
        expect(g.getState().selectedId).toBeNull();
    });

    test('known keys never warn — every prop getState() reports is accepted', () => {
        const g = makeGlobe();
        warnSpy.mockClear();
        const known = g.getState();
        g.setState(known);
        g.setState({ selectedId: 'front', hoveredId: null, zoom: 1.5, focus: null });
        expect(warnSpy).not.toHaveBeenCalled();
        expect(g.getState().selectedId).toBe('front');
    });

    test('a mixed partial applies the known keys and warns once for the unknown', () => {
        const g = makeGlobe();
        warnSpy.mockClear();
        g.setState({ labels: true, lables: true });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('"lables"');
        expect(g.getState().labels).toBe(true);
    });
});
