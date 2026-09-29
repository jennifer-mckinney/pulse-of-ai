// src/config/categories.js
// Backend accessor for the CANONICAL source-category taxonomy.
//
// The taxonomy of record lives in public/js/config/design.config.js
// (CATEGORIES: 8 × {slug, label, color}) — the same registry the browser
// renders chips / legend / ribbon from, so backend enumeration and frontend
// rendering can never drift (same shared-UMD pattern as the city registry:
// see src/routes/posts.js and public/js/config/cities.config.js).
//
// Layering note: server code requiring a public/-served file is deliberate —
// the registry is UMD dual-export and this repo has no build step to copy a
// shared src/config file into public/. The design config is the source of
// record for both consumers.
//
// The canon (prototype master contract ∪ BRD/PRD §17):
//   social → Social, news → News, academic → Academic, policy → Policy,
//   nonprofit → Non-profit, developer → Developer, forums → Forums,
//   blog → Blogs
// Forums is first-class canon with ZERO seeded sources (the prototype
// renders it; the top-50 source registry has no forum source yet) — routes
// enumerate it honestly as zero, never invent sources for it. The legacy
// 'tech' slug is retired (migration 007 maps residual rows to developer).

'use strict';

const designConfig = require('../../public/js/config/design.config.js');

/** @type {Array<{slug: string, label: string, color: string}>} */
const CATEGORIES = designConfig.CATEGORIES;

/** Canonical slugs in registry (spec) order. */
const CATEGORY_SLUGS = designConfig.CATEGORY_SLUGS;

/** slug → prototype display label ('blog' → 'Blogs', 'nonprofit' → 'Non-profit'). */
const CAT_LABELS = designConfig.CAT_LABELS;

const SLUG_SET = new Set(CATEGORY_SLUGS);

/**
 * Whether a value is a canonical category slug.
 * @param {unknown} slug
 * @returns {boolean}
 */
function isCanonicalCategory(slug) {
    return typeof slug === 'string' && SLUG_SET.has(slug);
}

module.exports = {
    CATEGORIES,
    CATEGORY_SLUGS,
    CAT_LABELS,
    isCanonicalCategory,
};
