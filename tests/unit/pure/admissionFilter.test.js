// tests/unit/pure/admissionFilter.test.js
// PR #22 G6: the collection admission filter is versioned methodology. The
// registered admission_filter config must equal the code exactly, so any
// change to the patterns, search terms or scope rule fails here until a NEW
// version is registered (and migrated).

'use strict';

const fs = require('fs');
const path = require('path');
const filter = require('../../../src/collectors/ai-filter');
const { METHODOLOGY_VERSIONS, CURRENT_VERSIONS } = require('../../../src/config/methodology-registry');

const current = () => METHODOLOGY_VERSIONS.find(m => m.component === 'admission_filter' && m.version === CURRENT_VERSIONS.admission_filter);

test('the code declares the current registered version', () => {
    expect(CURRENT_VERSIONS.admission_filter).toBe(filter.ADMISSION_FILTER_VERSION);
    expect(current()).toBeTruthy();
});

test('the registered patterns are the code patterns, in order', () => {
    expect(current().config.patterns).toEqual(filter.PATTERNS.map(re => ({ source: re.source, flags: re.flags })));
    expect(current().config.search_terms).toEqual([...filter.SEARCH_TERMS]);
});

test('admission_filter@1.0.0 as registered (a released row is never edited)', () => {
    const v1 = METHODOLOGY_VERSIONS.find(m => m.component === 'admission_filter' && m.version === '1.0.0');
    expect(v1.config.patterns).toHaveLength(20);
    expect(v1.config.patterns[0]).toEqual({ source: '\\b(?:A\\.I\\.?|AI)(?![A-Za-z0-9])', flags: '' });
    expect(v1.config.scope_rule).toEqual(expect.objectContaining({ filter: expect.any(String), ai: expect.any(String) }));
});

test('migration 042 registers admission_filter@1.0.0 byte-identically and adds raw_posts.admission_mv_id', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../../src/db/migrations/042_admission_filter.sql'), 'utf8');
    const { insertSql } = require('../../../scripts/generate-methodology-migration');
    expect(sql).toContain(insertSql(METHODOLOGY_VERSIONS.find(m => m.component === 'admission_filter' && m.version === '1.0.0')));
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS admission_mv_id UUID REFERENCES methodology_versions\(id\)/);
});
