// Read an invoice PDF into structured fields. Supplier templates differ (labels, date styles,
// layouts), so this parser looks for meaning rather than fixed positions, and cross-checks
// itself: line items must multiply out, and lines must sum to the stated total.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { askJson, llmEnabled } from './llm.js';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse/lib/pdf-parse.js');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const num = (s) => Number(String(s).replace(/[$,\s]/g, ''));

export function parseDate(raw) {
  const s = raw.trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if ((m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(s))) return iso(m[3], m[2], m[1]);
  if ((m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) return iso(m[3], m[1], m[2]);
  return null;
}
const iso = (y, mon, d) => {
  const i = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
  return i < 0 ? null : `${y}-${String(i + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const LABELS = {
  number: /^(?:invoice\s*(?:no\.?|#|number|id)|bill\s*no\.?)\s*:\s*(.+)$/i,
  date: /^(?:invoice\s*date|date|issued|bill\s*date)\s*:\s*(.+)$/i,
  po: /^(?:purchase\s*order|po(?:\s*number)?|your\s*order\s*ref|customer\s*po)\s*:\s*(.+)$/i,
  total: /^(?:total(?:\s*due|\s*\(usd\))?|amount\s*payable|balance\s*due)\s*:\s*\$?([\d,]+\.\d{2})$/i,
  iban: /^remit\s*to\s*iban\s*:\s*(.+)$/i,
};

// A line item renders as "<sku+desc><qty>$<price>$<amount>" with no separators. Try every
// split of the digits before the first $ and keep the one where qty × price = amount.
function parseLine(line) {
  const m = /^(.*?)(\d+)\$([\d,]+\.\d{2})\$([\d,]+\.\d{2})$/.exec(line);
  if (!m) return null;
  const head = m[1] + m[2];
  const price = num(m[3]);
  const amount = num(m[4]);
  for (let k = 1; k <= Math.min(6, m[2].length + 3); k++) {
    const qtyStr = head.slice(-k);
    if (!/^\d+$/.test(qtyStr)) break;
    if (Math.abs(Number(qtyStr) * price - amount) < 0.005) return { text: head.slice(0, -k), qty: Number(qtyStr), price, amount };
  }
  return null;
}

export function parseInvoiceText(text, vendorNames = []) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = { lines: [] };
  for (const l of lines) {
    for (const [k, re] of Object.entries(LABELS)) {
      const m = re.exec(l);
      if (m && out[k] == null) out[k] = m[1].trim();
    }
    const item = parseLine(l);
    if (item) out.lines.push(item);
  }
  out.supplier = lines[0];
  out.dateRaw = out.date;
  out.date = out.date ? parseDate(out.date) : null;
  out.total = out.total != null ? num(out.total) : null;
  out.notes = lines.filter((l) => /bank details|reminder|second copy|new account/i.test(l));

  const checks = [];
  const sum = out.lines.reduce((s, l) => s + l.amount, 0);
  checks.push({ name: 'Line items multiply out (qty × price = amount)', ok: out.lines.length > 0 });
  checks.push({ name: 'Lines sum to stated total', ok: out.total != null && Math.abs(sum - out.total) < 0.01, detail: `${sum.toFixed(2)} vs ${out.total}` });
  for (const f of ['number', 'date', 'po', 'total', 'iban']) checks.push({ name: `Found ${f}`, ok: out[f] != null });
  out.checks = checks;
  out.confidence = checks.filter((c) => c.ok).length / checks.length;
  return out;
}

export async function extractInvoice(file) {
  const buf = await fs.readFile(file);
  const { text } = await pdf(buf);
  let fields = parseInvoiceText(text);
  fields.reader = 'built-in parser';
  if (fields.confidence < 1 && llmEnabled()) {
    try {
      const ai = await askJson('Extract supplier invoice fields as JSON: supplier, number, date (YYYY-MM-DD), po, total (number), iban, lines (array of {text, qty, price, amount}).', text);
      fields = { ...fields, ...ai, reader: 'Claude (parser was unsure)', confidence: 0.9 };
    } catch { /* keep the parser result and let the loop ask a human */ }
  }
  return { text, fields };
}
