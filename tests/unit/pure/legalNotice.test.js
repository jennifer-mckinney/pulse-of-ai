// tests/unit/pure/legalNotice.test.js
// The Appropriate Legal Notices the running UI must show (AGPL-3.0-or-later
// plus the section 7(b) author attribution, ADDITIONAL-TERMS.md):
//   - public/js/config/legal.config.js holds them as frozen data;
//   - index.html loads that config before main.js, has the "about" chip and
//     panel main.js renders into, and repeats every notice for no-JS
//     visitors inside <noscript>;
//   - main.js renders them with createElement/textContent (never innerHTML);
//   - the repository carries the license files the notices link to, and
//     package.json names the same license.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const legal = require('../../../public/js/config/legal.config');

const UPSTREAM = 'https://github.com/jennifer-mckinney/pulse-of-ai';
const byId = (id) => legal.NOTICE.find((n) => n.id === id);

describe('legal.config — the notice data', () => {
    test('lists copyright, attribution, license, terms, source and warranty in order', () => {
        expect(legal.NOTICE.map((n) => n.id))
            .toEqual(['copyright', 'attribution', 'license', 'terms', 'source', 'warranty']);
    });

    test('copyright line', () => {
        expect(byId('copyright').text).toBe('Copyright © 2026 Jennifer McKinney');
        expect(byId('copyright').href).toBeUndefined();
    });

    test('section 7(b) attribution: exact text, linked to the upstream repository', () => {
        expect(legal.UPSTREAM_URL).toBe(UPSTREAM);
        expect(byId('attribution')).toEqual({
            id: 'attribution', text: 'Built on Pulse of AI by Jennifer McKinney', href: UPSTREAM,
        });
    });

    test('license line names AGPL-3.0 and links to the LICENSE file', () => {
        expect(byId('license').text).toContain('AGPL-3.0');
        expect(byId('license').href).toBe(`${UPSTREAM}/blob/master/LICENSE`);
        expect(byId('terms').href).toBe(`${UPSTREAM}/blob/master/ADDITIONAL-TERMS.md`);
    });

    test('source-code link (AGPL section 13) points at SOURCE_URL', () => {
        expect(byId('source').text).toBe('Source code');
        expect(byId('source').href).toBe(legal.SOURCE_URL);
        expect(legal.SOURCE_URL).toMatch(/^https:\/\//);
    });

    test('no-warranty line', () => {
        expect(byId('warranty').text).toMatch(/^No warranty/);
        expect(byId('warranty').href).toBeUndefined();
    });

    test('every link is https', () => {
        for (const n of legal.NOTICE.filter((x) => x.href)) expect(n.href).toMatch(/^https:\/\//);
    });

    test('data only and deep-frozen', () => {
        expect(Object.isFrozen(legal)).toBe(true);
        expect(Object.isFrozen(legal.NOTICE)).toBe(true);
        for (const n of legal.NOTICE) {
            expect(Object.isFrozen(n)).toBe(true);
            for (const v of Object.values(n)) expect(typeof v).toBe('string');
        }
        expect(() => { 'use strict'; legal.NOTICE[0].text = 'x'; }).toThrow(TypeError);
    });
});

describe('index.html — mount points, script order, no-JS copy', () => {
    const html = read('public/index.html');

    test('loads legal.config.js before main.js', () => {
        const legalAt = html.indexOf('<script defer src="js/config/legal.config.js"></script>');
        const mainAt = html.indexOf('<script defer src="js/main.js"></script>');
        expect(legalAt).toBeGreaterThan(-1);
        expect(mainAt).toBeGreaterThan(legalAt);
    });

    test('has the about chip and the (initially hidden) panel it controls', () => {
        expect(html).toMatch(/<button[^>]*id="about-chip"[^>]*aria-controls="about-panel"/);
        expect(html).toMatch(/<div[^>]*id="about-panel"[^>]*hidden>/);
    });

    test('<noscript> repeats every notice line and link', () => {
        const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'));
        for (const n of legal.NOTICE) {
            expect(noscript).toContain(n.text);
            if (n.href) expect(noscript).toContain(`<a href="${n.href}">${n.text}</a>`);
        }
    });

    test('the panel ships the notices as static markup equal to the config', () => {
        // If legal.config.js fails to load the static list is what stays.
        const panel = html.slice(html.indexOf('id="about-panel"'), html.indexOf('</ul>', html.indexOf('id="about-panel"')));
        for (const n of legal.NOTICE) {
            expect(panel).toContain(`data-notice="${n.id}"`);
            if (n.href) expect(panel).toContain(`<a href="${n.href}" rel="noopener noreferrer">${n.text}</a>`);
            else expect(panel).toContain(n.text);
        }
        expect((panel.match(/<li /g) || []).length).toBe(legal.NOTICE.length);
    });

    test('no inline style attributes (strict CSP)', () => {
        expect(html).not.toMatch(/<[a-z][^>]*\sstyle=/i);
    });
});

describe('main.js — renders the notice through the DOM API only', () => {
    const main = read('public/js/main.js');

    test('reads PulseLegalConfig and fills #about-panel', () => {
        expect(main).toContain('window.PulseLegalConfig');
        expect(main).toContain("getElementById('about-panel')");
        expect(main).toContain('legalConfig.NOTICE.forEach');
        expect(main).toContain('renderLegalNotice();');
    });

    test('a missing or malformed config keeps the static notices and warns; the chip is never hidden', () => {
        expect(main).not.toMatch(/chip\.hidden = true;/);
        expect(main).toContain("console.warn('legal notices: PulseLegalConfig missing");
    });

    test('the config replaces the static notices only when complete and well-typed', () => {
        // isValidNoticeConfig: non-empty array, every entry an object with
        // string id and text (href a string when present); never throws.
        expect(main).toContain('function isValidNoticeConfig(cfg)');
        expect(main).toContain('cfg.NOTICE.length === 0');
        expect(main).toContain("typeof item.id === 'string'");
        expect(main).toContain("typeof item.text === 'string'");
        // Complete set exactly once; linked notices need a non-empty href.
        expect(main).toContain('REQUIRED_NOTICE_IDS');
        expect(main).toContain('LINKED_NOTICE_IDS');
        expect(main).toContain('new Set(ids).size !== ids.length');
        expect(main).toContain('if (isValidNoticeConfig(legalConfig)) {');
    });

    test('every drawer opening folds the panel away (observed, not one event)', () => {
        expect(main).toContain('MutationObserver');
        expect(main).toContain("['audit-drawer', 'health-drawer']");
        // Focus inside the folded panel moves to the drawer, never stranded.
        expect(main).toContain('strandsFocus');
    });

    test('never uses innerHTML / outerHTML / insertAdjacentHTML', () => {
        // Code use only: the file's comments name innerHTML to forbid it.
        expect(main).not.toMatch(/\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\s*\(/);
    });
});

describe('repository license files', () => {
    test('LICENSE is the GNU AGPL v3 text, complete', () => {
        const text = read('LICENSE');
        expect(text).toMatch(/^\s*GNU AFFERO GENERAL PUBLIC LICENSE\n\s*Version 3, 19 November 2007/);
        expect(text).toContain('13. Remote Network Interaction; Use with the GNU General Public License.');
        expect(text).toContain('END OF TERMS AND CONDITIONS');
        expect(text).toContain('How to Apply These Terms to Your New Programs');
    });

    test('ADDITIONAL-TERMS.md states the section 7(b) attribution the UI shows', () => {
        const terms = read('ADDITIONAL-TERMS.md');
        expect(terms).toContain('Copyright © 2026 Jennifer McKinney.');
        expect(terms).toContain(`'${byId('attribution').text}'`);
        expect(terms).toContain(UPSTREAM);
        expect(terms).toContain('section 7(b)');
    });

    test('package.json names the same license', () => {
        expect(JSON.parse(read('package.json')).license).toBe('AGPL-3.0-or-later');
    });
});
