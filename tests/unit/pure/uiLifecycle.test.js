// tests/unit/pure/uiLifecycle.test.js
// Regression tests for two PR #8 grumpy-review fixes in public/js/ui.js's
// onCitiesData (the 'pulse:data' handler):
//   #6 — while exploring, the ribbon timeseries is re-fetched once the last
//        fetch (state.timeseriesAt) is at least REFRESH_MS old, and NOT
//        before; outside explore mode a snapshot never fetches it.
//   #7 — a selected city that vanishes from the snapshot is cleared through
//        selectCity(null): the story's next-steps handshake gets
//        setExploreSelection(null) and the globe's selectedId, splitFor and
//        focus are cleared (not just the local detail panel).
//
// ui.js keeps its DOM state module-private, so each test loads a FRESH copy
// (jest.isolateModules) and drives it through its real public entry point,
// init(), with a minimal fake document (every getElementById is null, so the
// render functions bail), a fake story on window.PulseStory, a spy globe via
// PulseGlobe.getInstance, a fake fetch and a stubbed Date.now.

'use strict';

const api = require('../../../public/js/config/api.config');

const REFRESH_MS = api.REFRESH_MS;
const TS_URL = api.ENDPOINTS.timeseries;
const T0 = 1_800_000_000_000;

// Minimal normalized city (public/js/data.js normalizeCities shape).
function city(name, lat, lng) {
    return {
        city: name, lat, lng, country: 'XX',
        positive: 3, neutral: 1, negative: 1, total: 5,
        dominant: 'positive',
        shares: { positive: 0.6, neutral: 0.2, negative: 0.2 },
        sources: [], sourceDetails: [],
    };
}
const AUSTIN = city('Austin', 30.27, -97.74);
const BERLIN = city('Berlin', 52.52, 13.4);

let docListeners;
let now;
let dateSpy;
let fakeStory;
let fakeGlobe;
let fetchMock;

function dispatch(type, detail) {
    const fn = docListeners[type];
    if (!fn) throw new Error('no listener for ' + type);
    fn({ detail });
}

// Let the fetch → res.json() → then chain settle.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const timeseriesFetches = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).startsWith(TS_URL)).length;

// Load a fresh ui.js wired to the fakes and run init() with `cities`.
function bootUi(cities) {
    let ui;
    jest.isolateModules(() => {
        const globeMod = require('../../../public/js/globe');
        jest.spyOn(globeMod, 'getInstance').mockReturnValue(fakeGlobe);
        ui = require('../../../public/js/ui');
    });
    fakeStory.getCities = () => cities;
    ui.init();
    return ui;
}

beforeEach(() => {
    docListeners = {};
    now = T0;
    dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    fakeStory = {
        getState: () => ({ isDemo: false, exploring: false }),
        getCities: () => [],
        setExploreSelection: jest.fn(),
        consumePendingCity: jest.fn(() => null),
    };
    fakeGlobe = { setState: jest.fn() };
    fetchMock = jest.fn(() => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
    }));
    global.document = {
        getElementById: () => null,
        addEventListener: (type, fn) => { docListeners[type] = fn; },
    };
    global.window = { PulseStory: fakeStory };
    global.fetch = fetchMock;
});

afterEach(() => {
    dateSpy.mockRestore();
    delete global.document;
    delete global.window;
    delete global.fetch;
});

// ── #6 ribbon timeseries refresh cadence ────────────────────────────────────

describe('ribbon timeseries refresh while exploring (grumpy #6)', () => {
    test('re-fetches once timeseriesAt is REFRESH_MS old — and not a millisecond before', async () => {
        bootUi([AUSTIN, BERLIN]);
        dispatch('pulse:exploring-changed', { exploring: true });
        expect(timeseriesFetches()).toBe(1);          // explore entry
        await flush();                                  // stamps timeseriesAt = T0

        now = T0 + REFRESH_MS - 1;
        dispatch('pulse:data', { cities: [AUSTIN, BERLIN], isDemo: false });
        expect(timeseriesFetches()).toBe(1);          // still fresh

        now = T0 + REFRESH_MS;
        dispatch('pulse:data', { cities: [AUSTIN, BERLIN], isDemo: false });
        expect(timeseriesFetches()).toBe(2);          // aged out → refresh
        expect(fetchMock.mock.calls.at(-1)[0]).toMatch(new RegExp('^' + TS_URL + '\\?hours='));
        await flush();                                  // re-stamps at T0 + REFRESH_MS

        // The new stamp re-arms the gate: a poll right after does not refetch.
        now = T0 + REFRESH_MS + 1000;
        dispatch('pulse:data', { cities: [AUSTIN, BERLIN], isDemo: false });
        expect(timeseriesFetches()).toBe(2);

        now = T0 + 2 * REFRESH_MS;
        dispatch('pulse:data', { cities: [AUSTIN, BERLIN], isDemo: false });
        expect(timeseriesFetches()).toBe(3);
    });

    test('a failed fetch leaves the stamp unset, so the next snapshot retries', async () => {
        fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: false, status: 503 }));
        bootUi([AUSTIN]);
        dispatch('pulse:exploring-changed', { exploring: true });
        await flush();
        expect(timeseriesFetches()).toBe(1);

        now = T0 + 1000;
        dispatch('pulse:data', { cities: [AUSTIN], isDemo: false });
        expect(timeseriesFetches()).toBe(2);
    });

    test('story mode (not exploring): snapshots never fetch the timeseries', () => {
        bootUi([AUSTIN]);
        now = T0 + 10 * REFRESH_MS;
        dispatch('pulse:data', { cities: [AUSTIN], isDemo: false });
        expect(timeseriesFetches()).toBe(0);
    });
});

// ── #7 vanished selection is routed through selectCity(null) ────────────────

// The globe.setState calls that carry the explore selection props.
const selectionCalls = () =>
    fakeGlobe.setState.mock.calls.map(([partial]) => partial)
        .filter((partial) => partial && 'selectedId' in partial && 'focus' in partial);

describe('a vanished selected city is cleared via selectCity(null) (grumpy #7)', () => {
    function exploreWithAustinSelected() {
        bootUi([AUSTIN, BERLIN]);
        dispatch('pulse:exploring-changed', { exploring: true });
        dispatch('pulse:drill', { cityId: 'Austin' });
        // Precondition: the drill selected Austin on the story and the globe.
        expect(fakeStory.setExploreSelection).toHaveBeenLastCalledWith('Austin');
        const sel = selectionCalls().at(-1);
        expect(sel.selectedId).toBe('Austin');
        expect(typeof sel.splitFor).toBe('function');
        expect(sel.focus).toEqual({ lat: AUSTIN.lat, lon: AUSTIN.lng });
        fakeStory.setExploreSelection.mockClear();
        fakeGlobe.setState.mockClear();
    }

    test('story handshake and globe selection/split/focus are all reset', () => {
        exploreWithAustinSelected();
        dispatch('pulse:data', { cities: [BERLIN], isDemo: false });

        expect(fakeStory.setExploreSelection).toHaveBeenCalledTimes(1);
        expect(fakeStory.setExploreSelection).toHaveBeenCalledWith(null);
        const cleared = selectionCalls();
        expect(cleared).toHaveLength(1);
        expect(cleared[0].selectedId).toBeNull();
        expect(cleared[0].splitFor).toBeNull();
        expect(cleared[0].focus).toBeNull();
    });

    test('control: a selection still in the snapshot is left alone', () => {
        exploreWithAustinSelected();
        dispatch('pulse:data', { cities: [AUSTIN, BERLIN], isDemo: false });

        expect(fakeStory.setExploreSelection).not.toHaveBeenCalled();
        expect(selectionCalls()).toHaveLength(0);
    });
});
