#!/usr/bin/env node
// Cleans products.csv: trims whitespace, title-cases names, and fills any empty
// description by asking Claude for product copy. Prints the result as a table.
//
// Usage: node clean-products.js [input.csv]
// Requires ANTHROPIC_API_KEY in a .env file (searched for from here upward).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

// Verbatim system prompt — do not reword.
const SYSTEM_PROMPT =
  'You are a product copywriter for an IoT eCommerce Store. ' +
  'Always respond with a single JSON object matching: ' +
  '{ title: string, description: string, seo_keywords: string[] } ' +
  'Never include text outside the JSON object. No markdown fences.';

// --- env ------------------------------------------------------------------
// The .env may live above this folder, so walk up looking for it.
function loadEnv() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate, quiet: true });
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dotenv.config({ quiet: true });
  return null;
}

// --- CSV parsing (quoted fields, escaped quotes, CRLF) ---------------------
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
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

// --- cleaning -------------------------------------------------------------
// Trim, drop BOM / non-breaking and zero-width spaces, collapse internal runs.
function squashWhitespace(v) {
  return String(v ?? '')
    .replace(/^\uFEFF/, '')                    // byte-order mark
    .replace(/[\u00A0\u2007\u202F]/g, ' ')   // non-breaking spaces
    .replace(/[\u200B-\u200D]/g, '')          // zero-width chars
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokens containing a digit (40L, 1L, 2XL) keep their original casing, so unit
// suffixes are not flattened to "40l".
function toTitleCase(v) {
  return v
    .split(' ')
    .map(tok => (/\d/.test(tok)
      ? tok
      : tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase()))
    .join(' ');
}

// --- Claude ---------------------------------------------------------------
function extractJsonObject(text) {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Salvage a JSON object embedded in surrounding prose.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('model response was not valid JSON');
  }
}

// `descriptor` is the product name plus any extra CSV columns, comma-joined:
//   "Musical LED Smart bulb, MultiColor LED IoT, Music Iot"
async function generateDescription(client, descriptor) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: `Product: ${descriptor}` }],
  });

  // Safety classifiers can decline; content is empty or partial when they do.
  if (response.stop_reason === 'refusal') {
    throw new Error(`request refused (${response.stop_details?.category ?? 'unknown'})`);
  }

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();

  if (!text) throw new Error('model returned no text');

  const parsed = extractJsonObject(text);
  const description = parsed?.description;
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error('response JSON had no usable "description" field');
  }
  return description.trim();
}

// --- run ------------------------------------------------------------------
const envPath = loadEnv();
const inFile = process.argv[2] ?? 'products.csv';

let raw;
try {
  raw = fs.readFileSync(inFile, 'utf8');
} catch (err) {
  console.error(`Could not read ${inFile}: ${err.message}`);
  process.exit(1);
}

const rows = parseCsv(raw);
if (rows.length < 2) {
  console.error(`${inFile}: no data rows found`);
  process.exit(1);
}

const header = rows[0].map(h => squashWhitespace(h).toLowerCase());
const iName = header.indexOf('name');
const iDesc = header.indexOf('description');
const iPrice = header.indexOf('price');

// Any column that is not name/description/price is treated as an extra
// descriptor and appended after the name in the prompt, giving the shape
// "Product: <name>, <hint>, <hint>". Add a `tags` column to use this.
const CORE_COLUMNS = new Set(['name', 'description', 'price']);
const hintColumns = header
  .map((h, i) => (h && !CORE_COLUMNS.has(h) ? i : -1))
  .filter(i => i !== -1);

if (iName === -1) {
  console.error(`${inFile}: required "name" column is missing`);
  process.exit(1);
}

const products = [];
const notes = [];
const skipped = [];

rows.slice(1).forEach((cells, n) => {
  const lineNo = n + 1;

  // A short or long row is malformed but recoverable — read what is there.
  if (cells.length !== header.length) {
    notes.push(`row ${lineNo}: expected ${header.length} columns, found ${cells.length}`);
  }

  const rawName = squashWhitespace(cells[iName]);
  if (!rawName) {
    skipped.push(`row ${lineNo}: no product name — row skipped`);
    return;
  }

  const name = toTitleCase(rawName);
  if (name !== rawName) {
    notes.push(`row ${lineNo}: renamed "${rawName}" -> "${name}"`);
  } else if (name !== String(cells[iName] ?? '')) {
    notes.push(`row ${lineNo}: trimmed whitespace in name -> "${name}"`);
  }

  const price = iPrice === -1 ? '' : squashWhitespace(cells[iPrice]);
  if (price === '') {
    notes.push(`row ${lineNo}: missing price for "${name}"`);
  } else if (!Number.isFinite(Number(price.replace(/[$£€,]/g, '')))) {
    notes.push(`row ${lineNo}: price "${price}" is not a number — left as-is`);
  }

  const hints = hintColumns
    .map(i => squashWhitespace(cells[i]))
    .filter(Boolean);

  products.push({
    lineNo,
    name,
    descriptor: [name, ...hints].join(', '),
    description: iDesc === -1 ? '' : squashWhitespace(cells[iDesc]),
    price,
    generated: false,
  });
});

const needsCopy = products.filter(p => p.description === '');

if (needsCopy.length) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      `${needsCopy.length} product(s) have no description, but ANTHROPIC_API_KEY is not set.\n` +
      (envPath ? `Loaded env from: ${envPath}` : 'No .env file was found.')
    );
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  for (const product of needsCopy) {
    process.stderr.write(`Sending "Product: ${product.descriptor}"... `);
    try {
      product.description = await generateDescription(client, product.descriptor);
      product.generated = true;
      process.stderr.write('done\n');
    } catch (err) {
      // One bad row must not sink the whole run.
      process.stderr.write('failed\n');
      notes.push(`row ${product.lineNo}: description generation failed — ${err.message}`);
      product.description = '(generation failed)';
    }
  }
  process.stderr.write('\n');
}

// --- output ---------------------------------------------------------------
const MAX_CELL = 70;
console.table(products.map(p => ({
  name: p.name,
  description: p.description.length > MAX_CELL
    ? p.description.slice(0, MAX_CELL - 1) + '…'
    : p.description,
  price: p.price,
  source: p.generated ? 'claude' : 'csv',
})));

for (const product of products.filter(p => p.generated)) {
  console.log(`\nFull generated description — ${product.name}:\n${product.description}`);
}

if (notes.length || skipped.length) {
  console.log('\nnotes:');
  for (const note of [...skipped, ...notes]) console.log('  - ' + note);
}
