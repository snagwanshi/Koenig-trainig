#!/usr/bin/env node
// Cleans a messy product CSV: stray whitespace, shouty casing, missing descriptions.
// Usage: node clean-products.mjs [input.csv] [output.csv]

import { readFileSync, writeFileSync } from 'node:fs';

const [, , inFile = 'products.csv', outFile = 'products.clean.csv'] = process.argv;

// --- CSV parsing (RFC4180-ish: quoted fields, escaped quotes, CRLF) ---------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== '')); // drop blank lines
}

function toCsv(rows) {
  const esc = v => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return rows.map(r => r.map(esc).join(',')).join('\n') + '\n';
}

// --- Cleaning rules --------------------------------------------------------

// Strip BOM, non-breaking/zero-width spaces, trim, collapse internal runs.
function squashWhitespace(v) {
  return v
    .replace(/^\uFEFF/, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B-\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Only re-case values that are entirely uppercase ("shouty"). Leaves
// deliberate casing like "Trailblazer 40L Backpack" or "iPhone" untouched.
function normalizeCasing(v) {
  if (!/[a-zA-Z]/.test(v) || v !== v.toUpperCase()) return v;
  return v
    .split(' ')
    .map(tok => /\d/.test(tok)             // keep unit tokens: 40L, 1L, 2XL
      ? tok
      : tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase())
    .join(' ');
}

function normalizePrice(v) {
  const stripped = v.replace(/[$£€\s]/g, '').replace(/,(?=\d{3}\b)/g, '');
  if (stripped === '') return { value: '', issue: 'missing price' };
  const n = Number(stripped);
  if (!Number.isFinite(n)) return { value: v, issue: `unparseable price "${v}"` };
  return { value: n.toFixed(2) };
}

// --- Run -------------------------------------------------------------------
const rows = parseCsv(readFileSync(inFile, 'utf8'));
if (!rows.length) { console.error(`${inFile}: no data`); process.exit(1); }

const header = rows[0].map(h => squashWhitespace(h).toLowerCase());
const idx = name => header.indexOf(name);
const [iName, iDesc, iPrice] = ['name', 'description', 'price'].map(idx);
if (iName === -1) { console.error('missing required "name" column'); process.exit(1); }

const out = [header];
const notes = [];

rows.slice(1).forEach((raw, n) => {
  const lineNo = n + 1;
  const cells = header.map((_, i) => squashWhitespace(raw[i] ?? ''));

  if (raw.length !== header.length) {
    notes.push(`row ${lineNo}: expected ${header.length} columns, got ${raw.length}`);
  }
  // whitespace report, comparing against the raw source cells
  header.forEach((col, i) => {
    const before = raw[i] ?? '';
    if (before !== cells[i] && before.trim() !== '') {
      notes.push(`row ${lineNo}: trimmed whitespace in ${col} -> "${cells[i]}"`);
    }
  });

  if (iName !== -1) {
    const cased = normalizeCasing(cells[iName]);
    if (cased !== cells[iName]) {
      notes.push(`row ${lineNo}: recased name "${cells[iName]}" -> "${cased}"`);
      cells[iName] = cased;
    }
    if (cells[iName] === '') notes.push(`row ${lineNo}: EMPTY name`);
  }

  // Empty description is tolerated, never guessed at — just surfaced.
  if (iDesc !== -1 && cells[iDesc] === '') {
    notes.push(`row ${lineNo}: empty description for "${cells[iName] || '(unnamed)'}"`);
  }

  if (iPrice !== -1) {
    const { value, issue } = normalizePrice(cells[iPrice]);
    if (issue) notes.push(`row ${lineNo}: ${issue}`);
    cells[iPrice] = value;
  }

  out.push(cells);
});

writeFileSync(outFile, toCsv(out), 'utf8');

console.log(`${inFile} -> ${outFile}  (${out.length - 1} rows)`);
if (notes.length) {
  console.log('\nnotes:');
  for (const nte of notes) console.log('  - ' + nte);
} else {
  console.log('no issues found');
}
