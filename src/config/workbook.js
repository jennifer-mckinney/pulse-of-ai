// src/config/workbook.js
// Reader for the source workbook — the REGISTRY OF RECORD
// (docs/requirements/Top_50_Global_Online_Sources.xlsx, Rev. 4; ADR 0001).
//
// The workbook is read directly (no spreadsheet dependency): an .xlsx file is
// a zip archive, and this workbook stores every cell as an inline string or a
// number, so a small central-directory zip reader + a cell regex is enough.
// Used by:
//   - tests/unit/pure/sourceRegistry.test.js — asserts the code registry
//     (src/config/source-registry.js) matches the workbook 1:1 on rank, name
//     and category, and that the committed CSV export matches the workbook;
//   - scripts/export-workbook-csv.js — regenerates that CSV export.
//
// Section headers ("7. FORUMS (3)") carry the category; a row whose first
// cell is an integer is a source row. Section → canonical category slug is
// SECTION_CATEGORIES below (the 8-category canon, ADR 0001 ruling 7).

'use strict';

const fs = require('fs');
const zlib = require('zlib');

/** Workbook section title (upper-case, no number/count) → canonical slug. */
const SECTION_CATEGORIES = Object.freeze({
    'SOCIAL PLATFORMS': 'social',
    'NEWS OUTLETS': 'news',
    'ACADEMIC REPOSITORIES': 'academic',
    'POLICY AND POLITICAL ORGANIZATIONS': 'policy',
    'NON-PROFITS': 'nonprofit',
    'DEVELOPER COMMUNITIES': 'developer',
    FORUMS: 'forums',
    'BLOGS AND NEWSLETTERS': 'blog',
});

// ─── Minimal zip reader (central directory + inflateRaw) ─────────────────────

/**
 * Read every entry of a zip archive into memory.
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} entry name → uncompressed bytes
 */
function unzip(buf) {
    // End-of-central-directory record: signature 0x06054b50, within the last
    // 64 KiB + 22 bytes of the file.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const out = new Map();
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        // Local header: fixed 30 bytes + its own name/extra lengths.
        const lNameLen = buf.readUInt16LE(localOffset + 26);
        const lExtraLen = buf.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + lNameLen + lExtraLen;
        const data = buf.subarray(start, start + compSize);
        if (method === 0) out.set(name, Buffer.from(data));
        else if (method === 8) out.set(name, zlib.inflateRawSync(data));
        else throw new Error(`unsupported zip compression method ${method} for ${name}`);
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

// ─── Sheet parsing ────────────────────────────────────────────────────────────

function decodeXml(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&amp;/g, '&');
}

/** Column letters → 0-based index ('A' → 0, 'J' → 9). */
function colIndex(ref) {
    const letters = ref.replace(/\d+$/, '');
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

const textRuns = (body) => [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join('');

/**
 * Parse one worksheet XML into an array of rows (sparse → dense arrays of
 * strings). Supports inline strings, numbers and shared strings.
 * @param {string} xml
 * @param {string[]} [shared]  sharedStrings table, when the workbook has one
 * @returns {string[][]}
 */
function parseSheet(xml, shared = []) {
    const rows = [];
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const row = [];
        for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attrs = cm[1];
            const body = cm[2] || '';
            const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
            const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
            let value;
            if (type === 'inlineStr') value = textRuns(body);
            else if (type === 's') value = shared[Number((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1])] || '';
            else value = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
            const idx = ref ? colIndex(ref) : row.length;
            while (row.length < idx) row.push('');
            row[idx] = decodeXml(value);
        }
        rows.push(row);
    }
    return rows;
}

/**
 * Read the first worksheet ("Top 50 Sources") of the workbook.
 * @param {string} xlsxPath
 * @returns {string[][]}
 */
function readFirstSheet(xlsxPath) {
    const entries = unzip(fs.readFileSync(xlsxPath));
    const sheet = entries.get('xl/worksheets/sheet1.xml');
    if (!sheet) throw new Error(`${xlsxPath}: xl/worksheets/sheet1.xml missing`);
    const sharedXml = entries.get('xl/sharedStrings.xml');
    const shared = sharedXml
        ? [...sharedXml.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decodeXml(textRuns(m[1])))
        : [];
    return parseSheet(sheet.toString('utf8'), shared);
}

/** Column headers of a source row (the workbook's own header row). */
const WORKBOOK_COLUMNS = Object.freeze([
    'rank', 'source', 'metric_type', 'value', 'value_numeric', 'as_of',
    'publisher_of_figure', 'figure_type', 'credibility_basis', 'confidence',
]);

/**
 * Extract the source rows, tagging each with its section's category.
 * @param {string[][]} rows  sheet rows from readFirstSheet
 * @returns {Array<object>} { rank, source, category, section, ...WORKBOOK_COLUMNS }
 */
function extractSources(rows) {
    const out = [];
    let category = null;
    let section = null;
    for (const row of rows) {
        const first = (row[0] || '').trim();
        const header = first.match(/^\d+\.\s+(.+?)\s*\(.*\)\s*$/);
        if (header) {
            section = header[1].toUpperCase();
            category = SECTION_CATEGORIES[section];
            if (!category) throw new Error(`unknown workbook section '${header[1]}'`);
            continue;
        }
        if (!/^\d+$/.test(first)) continue;
        if (!category) throw new Error(`source row ${first} appears before any section header`);
        const rec = { category, section };
        WORKBOOK_COLUMNS.forEach((col, i) => { rec[col] = (row[i] || '').trim(); });
        rec.rank = Number(first);
        out.push(rec);
    }
    return out;
}

/** Read + extract in one step. */
function readWorkbookSources(xlsxPath) {
    return extractSources(readFirstSheet(xlsxPath));
}

// ─── CSV (the committed export) ───────────────────────────────────────────────

const CSV_COLUMNS = Object.freeze(['rank', 'category', ...WORKBOOK_COLUMNS.slice(1)]);

function csvCell(v) {
    const s = String(v === undefined || v === null ? '' : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize source rows to the committed CSV export format. */
function toCsv(sources) {
    const lines = [CSV_COLUMNS.join(',')];
    for (const s of sources) lines.push(CSV_COLUMNS.map(c => csvCell(s[c])).join(','));
    return lines.join('\n') + '\n';
}

/** Parse RFC 4180 CSV text into arrays of fields. */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') quoted = false;
            else field += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else if (ch !== '\r') field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

/** Parse the committed CSV export back into source records. */
function fromCsv(text) {
    const [header, ...body] = parseCsv(text);
    return body.filter(r => r.length > 1).map((r) => {
        const rec = {};
        header.forEach((h, i) => { rec[h] = r[i]; });
        rec.rank = Number(rec.rank);
        return rec;
    });
}

module.exports = {
    SECTION_CATEGORIES,
    WORKBOOK_COLUMNS,
    CSV_COLUMNS,
    unzip,
    parseSheet,
    readFirstSheet,
    extractSources,
    readWorkbookSources,
    toCsv,
    parseCsv,
    fromCsv,
};
