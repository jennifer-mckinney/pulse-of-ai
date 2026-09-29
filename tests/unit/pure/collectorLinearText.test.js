// tests/unit/pure/collectorLinearText.test.js
// F10-3 regression: upstream text is processed in linear time. The old
// regexes were quadratic (redactIdentities on 40k 'a' took ~1 s, so 1 MB
// took minutes, blocking the event loop). Each check compares 256 KB with
// 1 MB of the same pattern (tests/helpers/scaling.js): time must grow
// linearly (or 1 MB must finish outright fast), which catches quadratic
// behaviour without a wall-clock budget that flakes under load.

'use strict';

const { toPayload, htmlToText, redactIdentities, RAW_TEXT_CAP, MAX_TEXT } = require('../../../src/collectors/normalize');
const { parseScholarAlert } = require('../../../src/collectors/adapters/academic');
const { stripSignatures } = require('../../../src/collectors/adapters/nonprofit');
const { getSource } = require('../../../src/config/source-registry');

const MB = 1024 * 1024;
const { scaling } = require('../../helpers/scaling');

/** Build an input of ~n chars by repeating the unit. */
const rep = unit => n => unit.repeat(Math.max(1, Math.round(n / unit.length)));
const linear = (fn, unit) => {
    const r = scaling(fn, rep(unit), MB);
    return expect({ ...r, linear: r.linear }).toMatchObject({ linear: true });
};
const npr = getSource('npr');

const UNITS = {
    "'a'": 'a',
    "'<'": '<',
    "'<script '": '<script ',
    "'@'": '@',
    'email-ish runs': 'a.b-c_d+e%f',
    '"<a href=User:"': '<a href="User:x">',
    '"(" and spaces': '(      ',
};

describe.each(Object.entries(UNITS))('1 MB of %s', (_, unit) => {
    test('toPayload (text and title) is linear and capped', () => {
        linear(input => toPayload({ id: '1', title: input, text: input }, npr, npr.routes[0]), unit);
        const out = toPayload({ id: '1', title: rep(unit)(MB), text: rep(unit)(MB) }, npr, npr.routes[0]);
        if (out) expect(out.text.length).toBeLessThanOrEqual(MAX_TEXT);
    });

    test('htmlToText and redactIdentities on the FULL input are linear', () => {
        linear(htmlToText, unit);
        linear(redactIdentities, unit);
    });

    test('Wikipedia signature stripping and Scholar alert parsing are linear', () => {
        linear(stripSignatures, unit);
        linear(input => parseScholarAlert(input, null, 'm'), unit);
    });
});

test('raw input is cut before processing: only the first RAW_TEXT_CAP chars are read', () => {
    const tail = '@secret-handle-in-the-tail';
    const p = toPayload({ id: '1', title: 'AI', text: `${'word '.repeat(RAW_TEXT_CAP / 5)}${tail}` }, npr, npr.routes[0]);
    expect(p.text).not.toContain('secret-handle');
    expect(p.text.length).toBeLessThanOrEqual(MAX_TEXT);
});

test('the bounded e-mail pattern still redacts real addresses and handles', () => {
    expect(redactIdentities('write to first.last+tag@mail.example.co.uk or @someone_1 today'))
        .toBe('write to [email] or @[user] today');
    expect(redactIdentities('not-an-email@ nor a@b')).toBe('not-an-email@ nor a@b');
});

test('htmlToText keeps text, drops scripts and styles, decodes entities', () => {
    expect(htmlToText('<p>AI &amp; jobs</p><script>alert(1)</script><style>p{}</style><b>ok</b>&nbsp;&#233;'))
        .toBe('AI & jobs ok é');
    expect(htmlToText('a<br>b<li>c</li>')).toBe('a b c');
});

test('stripSignatures removes signature links, timestamps and talk markers', () => {
    const html = '<p>AI safety needs audits. <a href="/wiki/User:Someone">Someone</a> '
        + '(<a href="/wiki/User_talk:Someone">talk</a>) 12:34, 5 May 2026 (UTC)</p>';
    expect(stripSignatures(html)).toBe('AI safety needs audits.');
    expect(stripSignatures('<p>x &lt;b&gt; y</p>')).toBe('x &lt;b&gt; y');
});

test('the scaling check itself catches a quadratic pattern (the pre-F10-3 e-mail regex)', () => {
    const { scaling } = require('../../helpers/scaling');
    const quadratic = s => s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
    const r = scaling(quadratic, n => 'a'.repeat(n), 16 * 1024, 3);
    expect(r.ratio).toBeGreaterThan(10);
    expect(r.linear).toBe(false);
});
