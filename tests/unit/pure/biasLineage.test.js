// tests/unit/pure/biasLineage.test.js
// PR #8 review: a receipt / history row must be rendered with the bias
// methodology version that PRODUCED the assessment, not the newest one.
// resolveBiasLineage picks that version per row:
//   - recorded: bias_assessments.methodology_version_id (migration 010) names it;
//   - inferred: pre-lineage row (NULL column) → the bias version whose
//     effective_from is at or before the row's created_at; a row that predates
//     every registered version falls back to the EARLIEST one (flagged);
//   - null: no bias methodology registered at all.

'use strict';

const { resolveBiasLineage, currentBiasVersion } = require('../../../src/config/bias-lineage');

const V1 = { id: 'v1', model_name: 'bias-m', version: '1.0.0', config: { tag: 'one' },
    effective_from: new Date('2026-09-01T00:00:00Z'), deprecated_at: new Date('2026-09-20T00:00:00Z') };
const V2 = { id: 'v2', model_name: 'bias-m', version: '2.0.0', config: { tag: 'two' },
    effective_from: new Date('2026-09-20T00:00:00Z'), deprecated_at: null };
// Deliberately unsorted: the resolver must not depend on caller ordering.
const VERSIONS = [V2, V1];

describe('resolveBiasLineage()', () => {
    test('recorded: the stored methodology_version_id wins, even for an old version', () => {
        const r = resolveBiasLineage(
            { methodology_version_id: 'v1', created_at: new Date('2026-09-25T00:00:00Z') },
            VERSIONS);
        expect(r.mv).toBe(V1);
        expect(r.lineage).toBe('recorded');
        expect(r.fallback).toBe(false);
    });

    test('inferred: NULL lineage before the version change → the old version', () => {
        const r = resolveBiasLineage(
            { methodology_version_id: null, created_at: new Date('2026-09-10T00:00:00Z') },
            VERSIONS);
        expect(r.mv).toBe(V1);
        expect(r.lineage).toBe('inferred');
        expect(r.fallback).toBe(false);
    });

    test('inferred: NULL lineage after the version change → the new version', () => {
        const r = resolveBiasLineage(
            { methodology_version_id: null, created_at: new Date('2026-09-21T00:00:00Z') },
            VERSIONS);
        expect(r.mv).toBe(V2);
        expect(r.lineage).toBe('inferred');
    });

    test('inferred: a row exactly at effective_from belongs to that version (at-or-before)', () => {
        const r = resolveBiasLineage(
            { methodology_version_id: null, created_at: '2026-09-20T00:00:00.000Z' },
            VERSIONS);
        expect(r.mv).toBe(V2);
    });

    test('inferred fallback: a row older than every version → earliest, flagged', () => {
        const r = resolveBiasLineage(
            { methodology_version_id: null, created_at: new Date('2026-08-01T00:00:00Z') },
            VERSIONS);
        expect(r.mv).toBe(V1);
        expect(r.lineage).toBe('inferred');
        expect(r.fallback).toBe(true);
    });

    test('a recorded id that is not a registered bias version is inferred instead', () => {
        const r = resolveBiasLineage(
            { methodology_version_id: 'not-a-bias-row', created_at: new Date('2026-09-21T00:00:00Z') },
            VERSIONS);
        expect(r.mv).toBe(V2);
        expect(r.lineage).toBe('inferred');
    });

    test('no bias methodology registered → null mv, null lineage', () => {
        expect(resolveBiasLineage({ methodology_version_id: null, created_at: new Date() }, []))
            .toEqual({ mv: null, lineage: null, fallback: false });
        expect(resolveBiasLineage({ methodology_version_id: 'v1', created_at: new Date() }, null))
            .toEqual({ mv: null, lineage: null, fallback: false });
    });
});

describe('currentBiasVersion()', () => {
    test('newest non-deprecated version by effective_from', () => {
        expect(currentBiasVersion(VERSIONS)).toBe(V2);
    });
    test('null when every version is deprecated or none exist', () => {
        expect(currentBiasVersion([V1])).toBeNull();
        expect(currentBiasVersion([])).toBeNull();
    });
});
