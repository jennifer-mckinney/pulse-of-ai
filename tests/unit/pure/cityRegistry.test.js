// Pure unit tests for public/js/config/cities.config.js — the canonical city
// registry (gazetteer) consumed by BOTH src/routes/posts.js (backend geocode)
// and public/js/data.js (demo dataset + live zero-baseline).
//
// Registry-completeness invariants (research doc
// docs/research/2026-07-06-city-layer-configurability.md):
//   - all 30 prototype launch cities resolve (ids AND names match the
//     prototype's data.js city list — story/globe parity),
//   - coordinates within valid ranges, ids unique, lookup keys unique,
//   - findCity is case-insensitive and alias-aware, null on unknowns.

'use strict';

const registry = require('../../../public/js/config/cities.config.js');
const { CITY_REGISTRY, findCity, launchCities } = registry;

// The prototype's 30-city launch list (exported-assets/
// prototype-globe-artifact/design_handoff_pulse_of_ai/data.js), id → name.
// Hand-copied here as an independent parity fixture — do NOT derive it from
// the registry under test.
const PROTOTYPE_CITIES = {
    sf: 'San Francisco', nyc: 'New York', aus: 'Austin', tor: 'Toronto',
    mex: 'Mexico City', sao: 'São Paulo', bue: 'Buenos Aires', lon: 'London',
    par: 'Paris', ber: 'Berlin', bru: 'Brussels', ams: 'Amsterdam',
    sto: 'Stockholm', zur: 'Zurich', war: 'Warsaw', lag: 'Lagos',
    nai: 'Nairobi', cpt: 'Cape Town', tlv: 'Tel Aviv', dxb: 'Dubai',
    blr: 'Bangalore', mum: 'Mumbai', sin: 'Singapore', jak: 'Jakarta',
    tok: 'Tokyo', seo: 'Seoul', bei: 'Beijing', sha: 'Shanghai',
    syd: 'Sydney', mel: 'Melbourne',
};

const REGIONS = ['north_america', 'south_america', 'europe', 'africa',
    'middle_east', 'asia', 'oceania'];

describe('CITY_REGISTRY — shape and invariants', () => {
    test('every entry carries the full registry shape', () => {
        expect(CITY_REGISTRY.length).toBeGreaterThanOrEqual(30);
        for (const c of CITY_REGISTRY) {
            expect(typeof c.id).toBe('string');
            expect(c.id.length).toBeGreaterThan(0);
            expect(typeof c.name).toBe('string');
            expect(Array.isArray(c.aliases)).toBe(true);
            expect(typeof c.lat).toBe('number');
            expect(typeof c.lng).toBe('number');
            expect(c.country).toMatch(/^[A-Z]{2}$/);
            expect(REGIONS).toContain(c.region);
            expect([1, 2]).toContain(c.tier);
        }
    });

    test('coordinates are within valid ranges', () => {
        for (const c of CITY_REGISTRY) {
            expect(c.lat).toBeGreaterThanOrEqual(-90);
            expect(c.lat).toBeLessThanOrEqual(90);
            expect(c.lng).toBeGreaterThanOrEqual(-180);
            expect(c.lng).toBeLessThanOrEqual(180);
            // 0,0 (null island) would mean a placeholder slipped in
            expect(c.lat !== 0 || c.lng !== 0).toBe(true);
        }
    });

    test('ids are unique', () => {
        const ids = CITY_REGISTRY.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('uppercased name + alias lookup keys never collide', () => {
        const keys = [];
        for (const c of CITY_REGISTRY) {
            keys.push(c.name.toUpperCase());
            for (const a of c.aliases) keys.push(a.toUpperCase());
        }
        expect(new Set(keys).size).toBe(keys.length);
    });

    test('registry is deep-frozen (shared data-only state)', () => {
        expect(Object.isFrozen(CITY_REGISTRY)).toBe(true);
        expect(Object.isFrozen(CITY_REGISTRY[0])).toBe(true);
        expect(Object.isFrozen(CITY_REGISTRY[0].aliases)).toBe(true);
    });
});

describe('prototype parity — the 30 launch cities (tier 1)', () => {
    test('tier-1 ids and names match the prototype city list exactly', () => {
        const launch = launchCities();
        expect(launch).toHaveLength(30);
        const byId = Object.fromEntries(launch.map((c) => [c.id, c.name]));
        expect(byId).toEqual(PROTOTYPE_CITIES);
    });

    test('every prototype launch city resolves to coords and a country code', () => {
        for (const name of Object.values(PROTOTYPE_CITIES)) {
            const entry = findCity(name);
            expect(entry).not.toBeNull();
            expect(typeof entry.lat).toBe('number');
            expect(typeof entry.lng).toBe('number');
            expect(entry.country).toMatch(/^[A-Z]{2}$/);
        }
    });
});

describe('findCity — gazetteer lookup semantics', () => {
    test('exact name resolves', () => {
        expect(findCity('San Francisco').id).toBe('sf');
    });

    test('lookup is case-insensitive and whitespace-tolerant', () => {
        expect(findCity('new york').id).toBe('nyc');
        expect(findCity('  LONDON  ').id).toBe('lon');
        expect(findCity('sÃO PAULO').id).toBe('sao');
    });

    test('aliases resolve to the same entry as the canonical name', () => {
        expect(findCity('NYC')).toBe(findCity('New York'));
        expect(findCity('Bengaluru')).toBe(findCity('Bangalore'));
        expect(findCity('Sao Paulo')).toBe(findCity('São Paulo'));
        expect(findCity('CDMX')).toBe(findCity('Mexico City'));
    });

    test('unknown, empty, and non-string inputs return null (never throw)', () => {
        expect(findCity('Atlantis')).toBeNull();
        expect(findCity('')).toBeNull();
        expect(findCity('   ')).toBeNull();
        expect(findCity(null)).toBeNull();
        expect(findCity(undefined)).toBeNull();
        expect(findCity(42)).toBeNull();
    });
});
