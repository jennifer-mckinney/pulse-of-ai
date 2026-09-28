// tests/unit/pure/globeFallback.test.js
// P1-5: when getContext('2d') returns null, PulseGlobe.create() renders a DOM
// ranked-city list (name, volume, sentiment) into the mount from setState's
// cities, using textContent only. Driven with a stubbed canvas and a minimal
// fake DOM (no jsdom dependency). Also pins the P1-6 first-frame mark name.

'use strict';

const globe = require('../../../public/js/globe');

// ── Minimal fake DOM ────────────────────────────────────────────────────────
class FakeEl {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.style = {};
        this.attrs = {};
        this._text = '';
        this.listeners = {};
    }
    get firstChild() { return this.children[0] || null; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) {
        this.children = this.children.filter(x => x !== c);
        c.parentNode = null;
        return c;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    set textContent(v) { this.children = []; this._text = String(v); }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    // innerHTML is deliberately a trap: the fallback must never use it.
    set innerHTML(v) { throw new Error('innerHTML used: ' + v); }
    addEventListener(t, f) { this.listeners[t] = f; }
    removeEventListener(t) { delete this.listeners[t]; }
    getContext() { return null; }                 // canvas 2D unavailable
    querySelectorAll(cls) {
        const out = [];
        const walk = (n) => {
            if (n.className && n.className.split(' ').includes(cls)) out.push(n);
            n.children.forEach(walk);
        };
        walk(this);
        return out;
    }
}

let warnSpy;
beforeAll(() => {
    global.document = { createElement: tag => new FakeEl(tag) };
    global.window = { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
});
afterAll(() => {
    delete global.document;
    delete global.window;
});
beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => warnSpy.mockRestore());

const CITIES = [
    { id: 'lon', name: 'London', lat: 51.5, lon: -0.1, total: 20, positive: 10, neutral: 5, negative: 5 },
    { id: 'tok', name: 'Tokyo', lat: 35.7, lon: 139.7, total: 50, positive: 10, neutral: 10, negative: 30 },
    { id: 'xss', name: 'A&W <b>"Q\'s"</b>', lat: 0, lon: 0, total: 1, positive: 1, neutral: 0, negative: 0 },
    { id: 'bad', name: 'No coords', lat: null, lon: null, total: 99 },   // adaptCities drops it
];

function mountWithStubCanvas() {
    const mount = new FakeEl('div');
    const canvas = new FakeEl('canvas');
    mount.appendChild(canvas);
    return { mount, canvas };
}

describe('PulseGlobe.create — canvas-unavailable fallback (P1-5)', () => {
    test('renders a ranked list (name, volume, sentiment) into the mount', () => {
        const { mount, canvas } = mountWithStubCanvas();
        const g = globe.create(canvas);
        expect(canvas.style.display).toBe('none');
        const region = mount.querySelectorAll('globe-fallback')[0];
        expect(region.attrs.role).toBe('region');
        // Empty until data arrives, but the honest note is already there.
        expect(mount.querySelectorAll('globe-fallback-note')[0].textContent)
            .toMatch(/canvas rendering is not supported/);

        g.setState({ cities: CITIES });
        const items = mount.querySelectorAll('globe-fallback-list')[0].children;
        expect(items.map(li => li.children.map(s => s.textContent))).toEqual([
            ['Tokyo', '50 posts', '−0.40'],
            ['London', '20 posts', '+0.25'],
            ['A&W <b>"Q\'s"</b>', '1 post', '+1.00'],
        ]);
        g.destroy();
        expect(mount.querySelectorAll('globe-fallback')).toHaveLength(0);
    });

    test('city names land as raw text (textContent only, never markup)', () => {
        const { mount, canvas } = mountWithStubCanvas();
        const g = globe.create(canvas);
        g.setState({ cities: CITIES });   // FakeEl.innerHTML throws if touched
        const names = mount.querySelectorAll('gf-name').map(n => n.textContent);
        expect(names).toContain('A&W <b>"Q\'s"</b>');
        g.destroy();
    });

    test('re-renders on every cities update and ignores non-city setState', () => {
        const { mount, canvas } = mountWithStubCanvas();
        const g = globe.create(canvas);
        g.setState({ cities: CITIES.slice(0, 1) });
        g.setState({ zoom: 2 });
        expect(mount.querySelectorAll('globe-fallback-list')[0].children).toHaveLength(1);
        g.setState({ cities: CITIES });
        expect(mount.querySelectorAll('globe-fallback')).toHaveLength(1);
        expect(mount.querySelectorAll('globe-fallback-list')[0].children).toHaveLength(3);
        g.destroy();
    });

    test('a container mount gets the list beside the canvas it created', () => {
        const mount = new FakeEl('div');
        const created = [];
        global.document.createElement = (tag) => {
            const el = new FakeEl(tag);
            created.push(el);
            return el;
        };
        try {
            const g = globe.create(mount);
            g.setState({ cities: CITIES.slice(0, 2) });
            expect(mount.children.map(c => c.tagName)).toEqual(['CANVAS', 'DIV']);
            g.destroy();
            expect(mount.children).toHaveLength(0);
        } finally {
            global.document.createElement = tag => new FakeEl(tag);
        }
        expect(created.length).toBeGreaterThan(0);
    });
});

describe('rankedCityRows — pure ranking', () => {
    test('volume desc, name asc on ties; signed two-decimal sentiment', () => {
        const rows = globe.math.rankedCityRows([
            { name: 'B', volume: 5, sentiment: 0 },
            { name: 'A', volume: 5, sentiment: -0.126 },
            { name: 'C', volume: 9.4, sentiment: 0.5 },
        ]);
        expect(rows).toEqual([
            { rank: '1', name: 'C', volume: '9 posts', sentiment: '+0.50' },
            { rank: '2', name: 'A', volume: '5 posts', sentiment: '−0.13' },
            { rank: '3', name: 'B', volume: '5 posts', sentiment: '+0.00' },
        ]);
        expect(globe.math.rankedCityRows(null)).toEqual([]);
    });
});

describe('first-frame mark (P1-6)', () => {
    test('the exported mark name is the one landing.spec reads', () => {
        expect(globe.FIRST_FRAME_MARK).toBe('pulse:first-frame');
    });
});
