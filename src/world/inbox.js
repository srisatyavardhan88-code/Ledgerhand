// Renders the supplier invoices into real PDFs in the AP inbox. Each supplier has its own
// template, field labels and date style, the way real invoices differ from sender to sender.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { vendors, invoices } from './seed.js';

const styles = {
  'V-1001': { accent: '#c0392b', font: 'Georgia, serif', numLabel: 'Invoice No.', poLabel: 'Purchase Order', dateLabel: 'Invoice Date', totalLabel: 'TOTAL DUE', date: (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) },
  'V-1002': { accent: '#1f6f8b', font: 'Arial, sans-serif', numLabel: 'Invoice #', poLabel: 'Your order ref', dateLabel: 'Date', totalLabel: 'Amount payable', date: (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}` },
  'V-1003': { accent: '#5b2c83', font: 'Helvetica, sans-serif', numLabel: 'Invoice Number', poLabel: 'PO Number', dateLabel: 'Issued', totalLabel: 'Total (USD)', date: (d) => d.toISOString().slice(0, 10) },
  'V-1004': { accent: '#d35400', font: 'Verdana, sans-serif', numLabel: 'Bill no', poLabel: 'Customer PO', dateLabel: 'Bill date', totalLabel: 'Balance due', date: (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) },
  'V-1005': { accent: '#2e86de', font: 'Trebuchet MS, sans-serif', numLabel: 'Invoice ID', poLabel: 'PO', dateLabel: 'Invoice date', totalLabel: 'Total due', date: (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) },
};

const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function render(inv) {
  const v = vendors.find((x) => x.id === inv.vendor);
  const s = styles[inv.vendor];
  const total = inv.lines.reduce((t, l) => t + l.qty * l.price, 0);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:${s.font};color:#222;margin:48px;font-size:13px}h1{color:${s.accent};margin:0;font-size:26px}
.top{display:flex;justify-content:space-between;border-bottom:3px solid ${s.accent};padding-bottom:14px;margin-bottom:22px}
table{width:100%;border-collapse:collapse;margin-top:18px}th{background:${s.accent};color:#fff;text-align:left;padding:7px}td{padding:7px;border-bottom:1px solid #ddd}
.r{text-align:right}.tot{font-size:16px;font-weight:bold}.note{margin-top:20px;padding:10px;border:1px dashed ${s.accent}}
</style></head><body>
<div class="top"><div><h1>${v.name}</h1><div>${v.email}</div></div><div style="text-align:right"><h1 style="font-size:20px">INVOICE</h1>${inv.note ? `<div style="color:${s.accent};font-weight:bold">${inv.note.startsWith('REMINDER') ? inv.note : ''}</div>` : ''}</div></div>
<div>Bill to: Northwind Trading Co., Accounts Payable</div>
<p>${s.numLabel}: ${inv.number}<br>${s.dateLabel}: ${s.date(new Date(inv.date + 'T00:00:00Z'))}<br>${s.poLabel}: ${inv.po}</p>
<table><thead><tr><th>Item</th><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead><tbody>
${inv.lines.map((l) => `<tr><td>${l.sku}</td><td>${l.desc}</td><td class="r">${l.qty}</td><td class="r">${money(l.price)}</td><td class="r">${money(l.qty * l.price)}</td></tr>`).join('')}
</tbody></table>
<p class="r tot">${s.totalLabel}: ${money(total)}</p>
<p>Remit to IBAN: ${inv.bank || v.bank}</p>
${inv.note && !inv.note.startsWith('REMINDER') ? `<div class="note">${inv.note}</div>` : ''}
</body></html>`;
}

export async function makeInbox(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const inv of invoices) {
    await page.setContent(render(inv));
    await page.pdf({ path: path.join(dir, inv.file), format: 'A4' });
  }
  await browser.close();
  return invoices.map((i) => i.file);
}
