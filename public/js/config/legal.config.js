// PulseLegalConfig — the page's Appropriate Legal Notices (DATA ONLY).
// Pulse of AI is licensed under the GNU AGPL v3.0 or later (LICENSE) with
// one additional term under AGPL section 7(b) (ADDITIONAL-TERMS.md): the
// author attribution "Built on Pulse of AI by Jennifer McKinney", linked to
// the upstream repository, must be preserved in the Appropriate Legal
// Notices of any covered work, including a user interface reached over a
// network. main.js renders NOTICE into the header "about" panel
// (#about-panel) with createElement/textContent only; the same lines are
// repeated as static markup in index.html (the <noscript> block and the
// About-panel fallback) and in the footer of credits.html.
//
// Deployers of a MODIFIED version (AGPL section 13): point SOURCE_URL at
// the complete corresponding source of the version you run (your fork). The
// ATTRIBUTION entry is the section 7(b) term and must stay as it is.
//
// Exports data only (no functions); invariants locked by
// tests/unit/pure/legalNotice.test.js.
//
// Dual export guard: CommonJS (module.exports) for jest,
// window.PulseLegalConfig for browser script tags (same pattern as
// api.config.js).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();          // Node / jest
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseLegalConfig = factory();   // browser global
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Deep-freeze: shared, data-only state (same contract as api.config.js).
    function deepFreeze(node) {
        if (node && typeof node === 'object' && !Object.isFrozen(node)) {
            Object.freeze(node);
            for (const key of Object.keys(node)) deepFreeze(node[key]);
        }
        return node;
    }

    // Upstream repository: the target of the section 7(b) attribution link.
    const UPSTREAM_URL = 'https://github.com/jennifer-mckinney/pulse-of-ai';

    // Complete corresponding source of THIS deployment (AGPL section 13).
    // A modified version must point this at its own source.
    const SOURCE_URL = UPSTREAM_URL;

    // Rendered in this order, one line each. `href` makes the line a link.
    const NOTICE = [
        { id: 'copyright',   text: 'Copyright © 2026 Jennifer McKinney' },
        { id: 'attribution', text: 'Built on Pulse of AI by Jennifer McKinney', href: UPSTREAM_URL },
        { id: 'license',     text: 'Licensed under AGPL-3.0-or-later', href: UPSTREAM_URL + '/blob/master/LICENSE' },
        { id: 'terms',       text: 'Additional terms (AGPL section 7(b))', href: UPSTREAM_URL + '/blob/master/ADDITIONAL-TERMS.md' },
        { id: 'source',      text: 'Source code', href: SOURCE_URL },
        { id: 'warranty',    text: 'No warranty: provided "as is", without warranty of any kind (AGPL sections 15 and 16).' },
    ];

    return deepFreeze({ UPSTREAM_URL, SOURCE_URL, NOTICE });
}));
