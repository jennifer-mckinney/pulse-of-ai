// tests/unit/pure/biasVocabulary.test.js
// Pure unit tests for src/config/bias-vocabulary.js — the stored→rendered
// mapping shared by the audit fairness layers (G18) and /api/bias/history (G19).

'use strict';

const {
    severityLabel,
    layerName,
    citationFor,
    alertDetail,
    buildLayers,
} = require('../../../src/config/bias-vocabulary');

const BIAS_CONFIG = {
    layer_names: {
        location_concentration:    'Location concentration',
        platform_sentiment_parity: 'Demographic parity (source category)',
    },
    citations: {
        location_concentration:    'Suresh & Guttag (2021)',
        platform_sentiment_parity: 'Barocas & Selbst (2016)',
    },
    planned_layers: [
        { id: 'equalized_odds', name: 'Equalized odds', citation: 'Hardt et al. (2016)', note: 'Phase 3 — not yet enforced' },
    ],
};

describe('severityLabel — stored → alert|watch|pass vocabulary', () => {
    it('maps non-violations to pass regardless of stored severity', () => {
        expect(severityLabel({ is_violation: false, severity: null })).toBe('pass');
        expect(severityLabel({ is_violation: false, severity: 'warning' })).toBe('pass');
    });

    it('maps critical violations to alert and warning violations to watch', () => {
        expect(severityLabel({ is_violation: true, severity: 'critical' })).toBe('alert');
        expect(severityLabel({ is_violation: true, severity: 'warning' })).toBe('watch');
    });
});

describe('layerName / citationFor — versioned-config lookups', () => {
    it('reads display names and citations from the bias methodology config', () => {
        expect(layerName('platform_sentiment_parity', BIAS_CONFIG))
            .toBe('Demographic parity (source category)');
        expect(citationFor('location_concentration', BIAS_CONFIG))
            .toBe('Suresh & Guttag (2021)');
    });

    it('degrades gracefully without a config: title-cased name, null citation', () => {
        expect(layerName('negative_dominance', null)).toBe('Negative dominance');
        expect(citationFor('negative_dominance', null)).toBeNull();
    });
});

describe('alertDetail — deterministic detail line from stored fields only', () => {
    it('includes metric, value, threshold (τ), and group', () => {
        const detail = alertDetail({
            assessment_type: 'location_concentration',
            metric_name:     'share_of_total',
            metric_value:    0.412,
            threshold:       0.35,
            group_value:     'San Francisco',
            is_violation:    true,
        }, BIAS_CONFIG);
        expect(detail).toContain('share_of_total');
        expect(detail).toContain('0.412');
        expect(detail).toContain('τ = 0.35');
        expect(detail).toContain('San Francisco');
        expect(detail).toContain('Threshold exceeded.');
    });

    it('omits the global/none pseudo-groups and marks within-threshold rows', () => {
        const detail = alertDetail({
            assessment_type: 'negative_dominance',
            metric_name:     'negative_share',
            metric_value:    0.2,
            threshold:       0.6,
            group_value:     'all',
            is_violation:    false,
        }, null);
        expect(detail).not.toContain(' for all');
        expect(detail).toContain('Within threshold.');
    });
});

describe('buildLayers — per-job fairness layers for the audit receipt', () => {
    const ASSESSMENTS = [
        {
            assessment_type: 'location_concentration',
            metric_value: 0.41, threshold: 0.35,
            is_violation: true, severity: 'warning',
        },
        {
            assessment_type: 'platform_sentiment_parity',
            metric_value: 0.031, threshold: 0.30,
            is_violation: false, severity: null,
        },
    ];

    it('maps computed assessments to pass/fail layers with value, τ, and citation', () => {
        const layers = buildLayers(ASSESSMENTS, BIAS_CONFIG);
        const loc = layers.find(l => l.assessment_type === 'location_concentration');
        expect(loc).toMatchObject({
            name:      'Location concentration',
            value:     0.41,
            threshold: 0.35,
            citation:  'Suresh & Guttag (2021)',
            status:    'fail',
            severity:  'watch',
        });
        const parity = layers.find(l => l.assessment_type === 'platform_sentiment_parity');
        expect(parity).toMatchObject({ status: 'pass', severity: 'pass', value: 0.031 });
    });

    it('appends planned-but-not-computed layers as n-a with a note', () => {
        const layers = buildLayers(ASSESSMENTS, BIAS_CONFIG);
        const planned = layers.find(l => l.assessment_type === 'equalized_odds');
        expect(planned).toMatchObject({
            name:      'Equalized odds',
            value:     null,
            threshold: null,
            citation:  'Hardt et al. (2016)',
            status:    'n-a',
            note:      'Phase 3 — not yet enforced',
        });
    });

    it('keeps only the LATEST row per assessment_type (rows arrive oldest→newest)', () => {
        const layers = buildLayers([
            { assessment_type: 'negative_dominance', metric_value: 0.7, threshold: 0.6, is_violation: true,  severity: 'warning' },
            { assessment_type: 'negative_dominance', metric_value: 0.2, threshold: 0.6, is_violation: false, severity: null },
        ], null);
        expect(layers).toHaveLength(1);
        expect(layers[0]).toMatchObject({ value: 0.2, status: 'pass' });
    });

    it('returns only planned layers (or []) when nothing was assessed', () => {
        expect(buildLayers([], null)).toEqual([]);
        const layers = buildLayers([], BIAS_CONFIG);
        expect(layers).toHaveLength(1);
        expect(layers[0].status).toBe('n-a');
    });
});
