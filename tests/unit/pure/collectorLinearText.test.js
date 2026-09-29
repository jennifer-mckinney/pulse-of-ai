// tests/unit/pure/collectorLinearText.test.js
// F10-3 regression: upstream text is processed in linear time. The old
// regexes were quadratic (redactIdentities on 40k 'a' took ~1 s, so 1 MB
// took minutes, blocking the event loop). Each 1 MB input must complete in
// under 50 ms; the helper warms the code path first so JIT compilation is
// not measured.

'use strict';

const { toPayload, htmlToText, redactIdentities, RAW_TEXT_CAP, MAX_TEXT } = require('../../../src/collectors/normalize');
const { parseScholarAlert } = require('../../../src/collectors/adapters/academic');
const { stripSignatures } = require('../../../src/collectors/adapters/nonprofit');
const { getSource } = require('../../../src/config/source-registry');

const MB = 1024 * 1024;
const npr = getSource('npr');

function timed(fn) {
    fn();                               // warm-up
    const t0 = process.hrtime.bigint();
    const out = fn();
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out };
}

const INPUTS = {
    "1 MB of 'a'": 'a'.repeat(MB),
    "1 MB of '<'": '<'.repeat(MB),
    "1 MB of '<script '": '<script '.repeat(MB / 8),
    "1 MB of '@'": '@'.repeat(MB),
    '1 MB of email-ish runs': 'a.b-c_d+e%f'.repeat(MB / 11),
    '1 MB of "<a href=User:"': '<a href="User:x">'.repeat(MB / 17),
    '1 MB of "(" and spaces': '(      '.repeat(MB / 7),
};

describe.each(Object.entries(INPUTS))('%s', (_, input) => {
    test('toPayload (text and title) completes in < 50 ms', () => {
        const { ms, out } = timed(() => toPayload({ id: '1', title: input, text: input }, npr, npr.routes[0]));
        expect(ms).toBeLessThan(50);
        if (out) expect(out.text.length).toBeLessThanOrEqual(MAX_TEXT);
    });

    test('htmlToText and redactIdentities on the FULL input complete in < 50 ms', () => {
        expect(timed(() => htmlToText(input)).ms).toBeLessThan(50);
        expect(timed(() => redactIdentities(input)).ms).toBeLessThan(50);
    });

    test('Wikipedia signature stripping and Scholar alert parsing complete in < 50 ms', () => {
        expect(timed(() => stripSignatures(input)).ms).toBeLessThan(50);
        expect(timed(() => parseScholarAlert(input, null, 'm')).ms).toBeLessThan(50);
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
