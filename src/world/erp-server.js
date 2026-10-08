// Northwind Ledger: a small but real ERP web app the operator has to work through a browser.
// It has the rough edges real internal tools have: sessions that expire, a modal notice that
// blocks the page, a strict date format, slow pages, and server-side validation.
import express from 'express';
import crypto from 'node:crypto';
import { vendors, purchaseOrders, receipts } from './seed.js';

const ACCOUNTS = { 'ledgerhand.svc': 'northwind-demo', 'lena.hart': 'northwind-demo' };
const APPROVAL_THRESHOLD = 10000;

export function createErp({ sessionRequestLimit = 40, slowMs = 400, freezeNotice = true } = {}) {
  let db;
  const sessions = new Map();
  const acknowledged = new Set();

  function reset() {
    db = {
      vendors: structuredClone(vendors),
      pos: structuredClone(purchaseOrders),
      receipts: structuredClone(receipts),
      invoices: [],
      seq: 7000,
      audit: [],
    };
    sessions.clear();
    acknowledged.clear();
  }
  reset();

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  const vendorName = (id) => db.vendors.find((v) => v.id === id)?.name ?? id;
  const poTotal = (po) => po.lines.reduce((s, l) => s + l.qty * l.price, 0);
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function nextFriday(from = new Date()) {
    const d = new Date(from);
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7));
    return d.toISOString().slice(0, 10);
  }

  function layout(title, body, { user, notice } = {}) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · Northwind Ledger</title>
<style>
*{box-sizing:border-box}body{margin:0;font:13px/1.45 Tahoma,Verdana,sans-serif;background:#e9ecef;color:#1d2731}
header{background:#24374d;color:#fff;padding:10px 18px;display:flex;align-items:center;gap:18px}
header b{font-size:15px;letter-spacing:.5px}header small{opacity:.6}header .who{margin-left:auto;opacity:.85}
nav{width:180px;background:#f7f8f9;border-right:1px solid #c9d0d6;padding:12px 0;min-height:calc(100vh - 42px)}
nav a{display:block;padding:7px 18px;color:#24374d;text-decoration:none}nav a:hover{background:#dde4ea}
.wrap{display:flex}main{flex:1;padding:18px 24px;max-width:1000px}
h1{font-size:18px;margin:0 0 12px;color:#24374d}h2{font-size:14px;margin:18px 0 8px;color:#24374d}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #c9d0d6}
th,td{padding:6px 9px;border-bottom:1px solid #e1e5e9;text-align:left}th{background:#eef1f4;font-weight:600}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.card{background:#fff;border:1px solid #c9d0d6;padding:14px 16px;margin-bottom:14px}
dl{display:grid;grid-template-columns:170px 1fr;gap:6px 12px;margin:0}dt{color:#5b6875}dd{margin:0;font-weight:600}
label{display:block;margin:10px 0 3px;color:#38495a}input,select,textarea{font:inherit;padding:5px 7px;border:1px solid #9aa6b2;width:340px;background:#fff}
button{font:inherit;padding:6px 14px;background:#2d6a9f;color:#fff;border:1px solid #1f4f78;cursor:pointer;margin-right:8px}
button.secondary{background:#fff;color:#24374d;border-color:#9aa6b2}
.err{background:#fde8e8;border:1px solid #d9534f;color:#8a1f1c;padding:9px 12px;margin-bottom:12px}
.ok{background:#e6f4ea;border:1px solid #4a9a5b;color:#1e5a2b;padding:9px 12px;margin-bottom:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:9px;background:#dde4ea;font-size:12px}
.pill.Posted{background:#d4edda}.pill.Scheduled{background:#cfe2ff}.pill.On{background:#fff3cd}
.modal-backdrop{position:fixed;inset:0;background:rgba(20,30,40,.55);display:flex;align-items:center;justify-content:center;z-index:50}
.modal{background:#fff;width:440px;padding:18px 20px;border-top:4px solid #e0a100}
.spinner{color:#5b6875;font-style:italic}
</style></head><body>
<header><b>Northwind Ledger</b><small>ERP 7.2 · Finance</small>${user ? `<span class="who">Signed in as ${esc(user)} · <a href="/logout" style="color:#cfe">Sign out</a></span>` : ''}</header>
<div class="wrap">${user ? `<nav><a href="/">Home</a><a href="/vendors">Suppliers</a><a href="/purchase-orders">Purchase orders</a><a href="/receipts">Goods receipts</a><a href="/invoices">Invoice register</a><a href="/invoices/new">Enter invoice</a></nav>` : ''}
<main>${body}</main></div>${notice || ''}</body></html>`;
  }

  // ---- auth -------------------------------------------------------------------------------
  function auth(req, res, next) {
    const sid = /nl_sid=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    const s = sid && sessions.get(sid);
    if (!s) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}${sid ? '&expired=1' : ''}`);
    s.requests += 1;
    if (s.requests > sessionRequestLimit) {
      sessions.delete(sid);
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}&expired=1`);
    }
    req.user = s.user;
    next();
  }

  app.get('/login', (req, res) => {
    const msg = req.query.expired ? '<div class="err">Your session has expired. Please sign in again.</div>' : req.query.bad ? '<div class="err">Invalid user name or password.</div>' : '';
    res.send(layout('Sign in', `<div class="card" style="max-width:420px"><h1>Sign in</h1>${msg}
<form method="post" action="/login"><input type="hidden" name="next" value="${esc(req.query.next || '/')}">
<label for="username">User name</label><input id="username" name="username" autocomplete="off">
<label for="password">Password</label><input id="password" name="password" type="password">
<div style="margin-top:14px"><button type="submit">Sign in</button></div></form></div>`));
  });
  app.post('/login', (req, res) => {
    const { username, password, next = '/' } = req.body;
    if (ACCOUNTS[username] !== password) return res.redirect(`/login?bad=1&next=${encodeURIComponent(next)}`);
    const sid = crypto.randomBytes(12).toString('hex');
    sessions.set(sid, { user: username, requests: 0 });
    res.setHeader('Set-Cookie', `nl_sid=${sid}; Path=/; HttpOnly`);
    res.redirect(next.startsWith('/') ? next : '/');
  });
  app.get('/logout', (req, res) => { res.setHeader('Set-Cookie', 'nl_sid=; Path=/; Max-Age=0'); res.redirect('/login'); });


  // ---- pages ------------------------------------------------------------------------------
  app.get('/', auth, (req, res) => {
    const notice = freezeNotice && !acknowledged.has(req.user)
      ? `<div class="modal-backdrop" id="freeze-notice"><div class="modal" role="dialog" aria-label="Quarter-end notice"><h2 style="margin-top:0">Quarter-end close notice</h2>
<p>Q3 books close Friday. Post supplier invoices by Thursday 18:00 so they make the Friday payment run.</p>
<form method="post" action="/notice/ack"><button type="submit">Acknowledge</button></form></div></div>` : '';
    const open = db.invoices.filter((i) => i.status !== 'Scheduled').length;
    res.send(layout('Home', `<h1>Finance workspace</h1><div class="card"><dl>
<dt>Open purchase orders</dt><dd>${db.pos.filter((p) => p.status === 'Open').length}</dd>
<dt>Invoices awaiting payment</dt><dd>${open}</dd><dt>Next payment run</dt><dd>${nextFriday()}</dd></dl></div>
<div class="card"><a href="/invoices/new">Enter a supplier invoice</a> · <a href="/invoices">Search invoice register</a></div>`, { user: req.user, notice }));
  });
  app.post('/notice/ack', auth, (req, res) => { acknowledged.add(req.user); res.redirect('/'); });

  app.get('/vendors', auth, (req, res) => {
    res.send(layout('Suppliers', `<h1>Suppliers</h1><table><thead><tr><th>ID</th><th>Name</th><th>Terms</th></tr></thead><tbody>
${db.vendors.map((v) => `<tr><td><a href="/vendors/${v.id}">${v.id}</a></td><td>${esc(v.name)}</td><td>${v.terms}</td></tr>`).join('')}</tbody></table>`, { user: req.user }));
  });
  app.get('/vendors/:id', auth, (req, res) => {
    const v = db.vendors.find((x) => x.id === req.params.id);
    if (!v) return res.status(404).send(layout('Not found', '<div class="err">Supplier not found.</div>', { user: req.user }));
    res.send(layout(v.name, `<h1>${esc(v.name)}</h1><div class="card" id="supplier"><dl>
<dt>Supplier ID</dt><dd data-field="id">${v.id}</dd><dt>Remittance email</dt><dd data-field="email">${esc(v.email)}</dd>
<dt>Bank account (IBAN)</dt><dd data-field="bank">${esc(v.bank)}</dd><dt>Payment terms</dt><dd data-field="terms">${v.terms}</dd></dl></div>
<p style="color:#5b6875">Bank detail changes require a signed change form and Security sign-off.</p>`, { user: req.user }));
  });

  app.get('/purchase-orders', auth, (req, res) => {
    res.send(layout('Purchase orders', `<h1>Purchase orders</h1><table><thead><tr><th>PO</th><th>Supplier</th><th>Status</th><th class="num">Value</th></tr></thead><tbody>
${db.pos.map((p) => `<tr><td><a href="/purchase-orders/${p.po}">${p.po}</a></td><td>${esc(vendorName(p.vendor))}</td><td>${p.status}</td><td class="num">${money(poTotal(p))}</td></tr>`).join('')}</tbody></table>`, { user: req.user }));
  });
  app.get('/purchase-orders/:po', auth, async (req, res) => {
    await new Promise((r) => setTimeout(r, slowMs));
    const p = db.pos.find((x) => x.po === req.params.po);
    if (!p) return res.status(404).send(layout('Not found', `<div class="err">Purchase order ${esc(req.params.po)} not found.</div>`, { user: req.user }));
    res.send(layout(p.po, `<h1>Purchase order ${p.po}</h1><div class="card"><dl><dt>Supplier</dt><dd data-field="vendor">${p.vendor} · ${esc(vendorName(p.vendor))}</dd>
<dt>Status</dt><dd data-field="status">${p.status}</dd><dt>Total</dt><dd data-field="total">${money(poTotal(p))}</dd></dl></div>
<table id="po-lines"><thead><tr><th>SKU</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Line total</th></tr></thead><tbody>
${p.lines.map((l) => `<tr><td>${l.sku}</td><td>${esc(l.desc)}</td><td class="num">${l.qty}</td><td class="num">${money(l.price)}</td><td class="num">${money(l.qty * l.price)}</td></tr>`).join('')}</tbody></table>`, { user: req.user }));
  });

  app.get('/receipts', auth, (req, res) => {
    const list = req.query.po ? db.receipts.filter((r) => r.po === req.query.po) : db.receipts;
    res.send(layout('Goods receipts', `<h1>Goods receipts${req.query.po ? ' for ' + esc(req.query.po) : ''}</h1>
<form method="get" action="/receipts" style="margin-bottom:12px"><label for="po">Purchase order</label><input id="po" name="po" value="${esc(req.query.po || '')}"> <button type="submit">Search</button></form>
${list.length ? `<table id="receipt-lines"><thead><tr><th>GRN</th><th>PO</th><th>Date</th><th>SKU</th><th class="num">Qty received</th></tr></thead><tbody>
${list.flatMap((r) => r.lines.map((l) => `<tr><td>${r.grn}</td><td>${r.po}</td><td>${r.date}</td><td>${l.sku}</td><td class="num">${l.qty}</td></tr>`)).join('')}</tbody></table>` : '<div class="card">No goods receipts found.</div>'}`, { user: req.user }));
  });

  app.get('/invoices', auth, (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    const list = q ? db.invoices.filter((i) => i.number.toLowerCase().includes(q) || i.ref.toLowerCase() === q) : db.invoices;
    res.send(layout('Invoice register', `<h1>Invoice register</h1>
<form method="get" action="/invoices" style="margin-bottom:12px"><label for="q">Search by supplier invoice number</label><input id="q" name="q" value="${esc(req.query.q || '')}"> <button type="submit">Search</button></form>
${list.length ? `<table id="register"><thead><tr><th>AP ref</th><th>Supplier</th><th>Supplier invoice</th><th>PO</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
${list.map((i) => `<tr><td><a href="/invoices/${i.ref}">${i.ref}</a></td><td>${esc(vendorName(i.vendor))}</td><td>${esc(i.number)}</td><td>${i.po}</td><td class="num">${money(i.amount)}</td><td><span class="pill ${i.status.split(' ')[0]}">${i.status}</span></td></tr>`).join('')}</tbody></table>`
    : `<div class="card" id="no-results">No invoices match${q ? ' “' + esc(req.query.q) + '”' : ''}.</div>`}`, { user: req.user }));
  });

  function invoiceForm(user, values = {}, error = '') {
    const opt = (v, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${v}</option>`;
    return layout('Enter invoice', `<h1>Enter supplier invoice</h1>${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
<form method="post" action="/invoices" class="card">
<label for="vendor">Supplier</label><select id="vendor" name="vendor"><option value="">— select —</option>${db.vendors.map((v) => `<option value="${v.id}"${v.id === values.vendor ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select>
<label for="number">Supplier invoice number</label><input id="number" name="number" value="${esc(values.number)}">
<label for="po">Purchase order</label><input id="po" name="po" value="${esc(values.po)}">
<label for="date">Invoice date (DD/MM/YYYY)</label><input id="date" name="date" value="${esc(values.date)}">
<label for="amount">Gross amount (USD)</label><input id="amount" name="amount" value="${esc(values.amount)}">
<label for="match">Match status</label><select id="match" name="match"><option value="">— select —</option>${['3-way matched', 'Within tolerance', 'Quantity exception'].map((m) => opt(m, values.match)).join('')}</select>
<label for="approval">Approval reference (required above ${money(APPROVAL_THRESHOLD)})</label><input id="approval" name="approval" value="${esc(values.approval)}">
<label for="notes">Notes</label><textarea id="notes" name="notes" rows="3">${esc(values.notes)}</textarea>
<div style="margin-top:14px"><button type="submit" name="action" value="post">Post invoice</button><button type="submit" name="action" value="hold" class="secondary">Park on hold</button></div>
</form>`, { user });
  }

  app.get('/invoices/new', auth, (req, res) => res.send(invoiceForm(req.user)));
  app.post('/invoices', auth, (req, res) => {
    const v = { ...req.body };
    const fail = (msg) => res.status(422).send(invoiceForm(req.user, v, msg));
    if (!v.vendor) return fail('Supplier is required.');
    if (!v.number) return fail('Supplier invoice number is required.');
    const po = db.pos.find((p) => p.po === v.po);
    if (!po) return fail(`Purchase order “${v.po}” does not exist.`);
    if (po.vendor !== v.vendor) return fail(`Purchase order ${v.po} belongs to a different supplier.`);
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(v.date || '')) return fail('Invoice date must be in DD/MM/YYYY format.');
    const amount = Number(String(v.amount).replace(/[$,]/g, ''));
    if (!(amount > 0)) return fail('Gross amount must be a positive number.');
    const dup = db.invoices.find((i) => i.vendor === v.vendor && i.number.toLowerCase() === v.number.toLowerCase());
    if (dup) return fail(`Duplicate invoice: ${v.number} is already recorded as ${dup.ref}.`);
    if (!v.match) return fail('Match status is required.');
    const hold = v.action === 'hold';
    if (!hold && amount > APPROVAL_THRESHOLD && !/^APR-\d{4,}$/.test(v.approval || '')) return fail(`Invoices above ${money(APPROVAL_THRESHOLD)} need an approval reference (APR-####).`);
    if (!hold && v.match === 'Quantity exception') return fail('Invoices with a quantity exception cannot be posted. Park on hold instead.');
    const ref = `AP-${++db.seq}`;
    const rec = { ref, vendor: v.vendor, number: v.number, po: v.po, date: v.date, amount, match: v.match, approval: v.approval || '', notes: v.notes || '',
      status: hold ? 'On hold' : 'Posted', postedBy: req.user, payment: null };
    db.invoices.push(rec);
    db.audit.push({ at: new Date().toISOString(), user: req.user, action: hold ? 'hold' : 'post', ref });
    res.redirect(`/invoices/${ref}?saved=1`);
  });

  app.get('/invoices/:ref', auth, (req, res) => {
    const i = db.invoices.find((x) => x.ref === req.params.ref);
    if (!i) return res.status(404).send(layout('Not found', '<div class="err">Invoice not found.</div>', { user: req.user }));
    const banner = req.query.saved ? `<div class="ok">Invoice saved as ${i.ref}.</div>` : req.query.scheduled ? `<div class="ok">Payment scheduled for ${i.payment}.</div>` : '';
    res.send(layout(i.ref, `${banner}<h1>Invoice ${i.ref}</h1><div class="card" id="invoice"><dl>
<dt>AP reference</dt><dd data-field="ref">${i.ref}</dd><dt>Supplier</dt><dd data-field="vendor">${i.vendor} · ${esc(vendorName(i.vendor))}</dd>
<dt>Supplier invoice</dt><dd data-field="number">${esc(i.number)}</dd><dt>Purchase order</dt><dd data-field="po">${i.po}</dd>
<dt>Invoice date</dt><dd data-field="date">${i.date}</dd><dt>Gross amount</dt><dd data-field="amount">${money(i.amount)}</dd>
<dt>Match status</dt><dd data-field="match">${i.match}</dd><dt>Approval</dt><dd data-field="approval">${esc(i.approval) || '—'}</dd>
<dt>Status</dt><dd data-field="status">${i.status}</dd><dt>Payment run</dt><dd data-field="payment">${i.payment || '—'}</dd>
<dt>Notes</dt><dd data-field="notes">${esc(i.notes) || '—'}</dd></dl></div>
${i.status === 'Posted' ? `<form method="post" action="/invoices/${i.ref}/schedule"><button type="submit">Schedule for payment run</button></form>` : ''}`, { user: req.user }));
  });
  app.post('/invoices/:ref/schedule', auth, (req, res) => {
    const i = db.invoices.find((x) => x.ref === req.params.ref);
    if (!i || i.status !== 'Posted') return res.status(409).send(layout('Error', '<div class="err">Only posted invoices can be scheduled.</div>', { user: req.user }));
    i.status = 'Scheduled';
    i.payment = nextFriday();
    db.audit.push({ at: new Date().toISOString(), user: req.user, action: 'schedule', ref: i.ref });
    res.redirect(`/invoices/${i.ref}?scheduled=1`);
  });

  return { app, reset, state: () => db };
}

export function startErp(port = Number(process.env.ERP_PORT || 4100), opts) {
  const erp = createErp(opts);
  return new Promise((resolve) => {
    const server = erp.app.listen(port, '127.0.0.1', () => resolve({ ...erp, server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startErp().then(({ url }) => console.log(`Northwind Ledger ERP on ${url}`));
}
