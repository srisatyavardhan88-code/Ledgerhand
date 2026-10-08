// Browser skills for Northwind Ledger. Everything goes through a real Chromium page: the
// operator reads what is on screen, clicks the same menus a clerk would, fills labelled form
// fields, and screenshots each state as evidence. Nothing here talks to the ERP's database.
import { chromium } from 'playwright';
import { SessionExpired, BlockedByOverlay, ValidationError, NotFound } from './recovery.js';

const CLICK_TIMEOUT = 2500;

export function formatDate(isoDate, fmt) {
  const [y, m, d] = isoDate.split('-');
  if (!fmt || fmt === 'YYYY-MM-DD') return isoDate;
  return fmt.replace('YYYY', y).replace('MM', m).replace('DD', d);
}

export class ErpSession {
  constructor({ run, ctx, memory, headed = process.env.HEADED === '1' }) {
    Object.assign(this, { run, ctx, memory, headed });
    this.base = ctx.erpUrl;
  }

  async start() {
    this.browser = await chromium.launch({ headless: !this.headed, slowMo: this.headed ? 120 : 0 });
    this.page = await (await this.browser.newContext({ viewport: { width: 1180, height: 760 } })).newPage();
    this.page.setDefaultTimeout(8000);
  }
  async stop() { await this.browser?.close(); }

  async snap(label, note) {
    const { file, rel } = this.run.shotPath(label);
    await this.page.screenshot({ path: file, type: 'jpeg', quality: 70 });
    this.run.emitEvent('screen', { src: rel, label, url: this.page.url().replace(this.base, ''), note });
    return rel;
  }

  // ---- observation helpers ---------------------------------------------------------------
  onLoginPage() { return new URL(this.page.url()).pathname === '/login'; }
  async ensureSignedIn() {
    if (this.onLoginPage()) { await this.snap('signed-out'); throw SessionExpired(); }
  }
  async ensureOnErp() {
    if (!this.page.url().startsWith(this.base)) await this.visit('/');
  }
  async visit(path) {
    const res = await this.page.goto(this.base + path);
    await this.ensureSignedIn();
    if (res && res.status() === 404) {
      const msg = (await this.page.locator('.err').first().textContent().catch(() => null)) || `Not found: ${path}`;
      await this.snap('not-found');
      throw NotFound(msg.trim());
    }
  }
  async click(locator, what) {
    try {
      await locator.click({ timeout: CLICK_TIMEOUT });
    } catch (e) {
      const dialog = await this.page.locator('[role=dialog]').count();
      if (dialog || /intercepts pointer events/.test(e.message)) {
        await this.snap('blocked-by-dialog', `Click on “${what}” was intercepted`);
        throw BlockedByOverlay(`Click on “${what}” was blocked by a dialog covering the page`);
      }
      throw e;
    }
    await this.page.waitForLoadState('domcontentloaded');
    await this.ensureSignedIn();
  }
  async openSection(name) {
    await this.ensureOnErp();
    await this.click(this.page.getByRole('navigation').getByRole('link', { name, exact: true }), name);
  }
  async readFields(scope = 'body') {
    return this.page.locator(`${scope} [data-field]`).evaluateAll((els) => Object.fromEntries(els.map((e) => [e.dataset.field, e.textContent.trim()])));
  }
  async readTable(selector) {
    const t = this.page.locator(selector);
    if (!(await t.count())) return [];
    return t.evaluate((table) => {
      const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      return [...table.querySelectorAll('tbody tr')].map((tr) => Object.fromEntries([...tr.children].map((td, i) => [heads[i], td.textContent.trim()])));
    });
  }

  // ---- skills -----------------------------------------------------------------------------
  async login() {
    const cred = this.ctx.vault[this.ctx.directory.systems.erp.credentialRef];
    if (!this.onLoginPage()) await this.page.goto(this.base + '/login');
    await this.page.getByLabel('User name').fill(cred.username);
    await this.page.getByLabel('Password').fill(cred.password);
    await this.page.getByRole('button', { name: 'Sign in' }).click();
    await this.page.waitForLoadState('domcontentloaded');
    if (this.onLoginPage()) { await this.snap('login-failed'); throw new Error('Sign-in rejected by the ERP'); }
    const shot = await this.snap('signed-in');
    return { user: cred.username, landedOn: new URL(this.page.url()).pathname, shot };
  }

  async dismissDialog() {
    const dialog = this.page.locator('[role=dialog]').first();
    if (!(await dialog.count())) return { dismissed: false, note: 'No dialog present any more' };
    const text = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
    const button = dialog.getByRole('button').first();
    const label = (await button.textContent()).trim();
    await button.click();
    await this.page.waitForLoadState('domcontentloaded');
    const shot = await this.snap('dialog-dismissed');
    return { dismissed: true, dialogText: text, pressed: label, shot };
  }

  async searchRegister(number) {
    await this.openSection('Invoice register');
    await this.page.getByLabel('Search by supplier invoice number').fill(number);
    await this.click(this.page.getByRole('button', { name: 'Search' }), 'Search');
    const rows = await this.readTable('#register');
    const shot = await this.snap(`register-${number}`);
    return { rows: rows.filter((r) => r['Supplier invoice'].toLowerCase() === number.toLowerCase()), shot };
  }

  async readSupplier(name) {
    await this.openSection('Suppliers');
    const row = this.page.getByRole('row').filter({ hasText: name });
    if (!(await row.count())) { await this.snap('supplier-missing'); throw NotFound(`Supplier “${name}” is not in the supplier master`); }
    await this.click(row.first().getByRole('link'), name);
    const fields = await this.readFields('#supplier');
    const shot = await this.snap(`supplier-${fields.id}`);
    return { ...fields, name, shot };
  }

  async readPurchaseOrder(po) {
    await this.visit(`/purchase-orders/${encodeURIComponent(po)}`);
    const fields = await this.readFields();
    const lines = (await this.readTable('#po-lines')).map((r) => ({ sku: r.SKU, desc: r.Description, qty: Number(r.Qty), price: Number(r['Unit price'].replace(/[$,]/g, '')) }));
    const shot = await this.snap(`po-${po}`);
    return { po, vendorId: fields.vendor.split(' · ')[0], status: fields.status, lines, shot };
  }

  async readReceipts(po) {
    await this.openSection('Goods receipts');
    await this.page.getByLabel('Purchase order').fill(po);
    await this.click(this.page.getByRole('button', { name: 'Search' }), 'Search');
    const rows = await this.readTable('#receipt-lines');
    const shot = await this.snap(`receipts-${po}`);
    const received = {};
    for (const r of rows) received[r.SKU] = (received[r.SKU] || 0) + Number(r['Qty received']);
    return { grns: [...new Set(rows.map((r) => r.GRN))], received, shot };
  }

  async enterInvoice(v, action) {
    await this.openSection('Enter invoice');
    const fmt = this.memory.get('erp.dateFormat');
    const p = this.page;
    await p.getByLabel('Supplier', { exact: true }).selectOption({ label: v.supplier });
    await p.getByLabel('Supplier invoice number').fill(v.number);
    await p.getByLabel('Purchase order').fill(v.po);
    await p.getByLabel(/^Invoice date/).fill(formatDate(v.date, fmt));
    await p.getByLabel(/^Gross amount/).fill(v.amount.toFixed(2));
    await p.getByLabel('Match status').selectOption({ label: v.match });
    await p.getByLabel(/^Approval reference/).fill(v.approval || '');
    await p.getByLabel('Notes').fill(v.notes || '');
    const filled = await this.snap(`form-${v.number}`, `Filled with date format ${fmt || 'YYYY-MM-DD (default)'}`);
    await this.click(p.getByRole('button', { name: action === 'hold' ? 'Park on hold' : 'Post invoice' }), action === 'hold' ? 'Park on hold' : 'Post invoice');
    const err = p.locator('.err[role=alert]');
    if (await err.count()) {
      const msg = (await err.textContent()).trim();
      const shot = await this.snap(`rejected-${v.number}`, msg);
      throw ValidationError(msg, shot);
    }
    const ref = /\/invoices\/(AP-\d+)/.exec(p.url())?.[1];
    const shot = await this.snap(`saved-${ref}`);
    return { ref, filled, shot };
  }

  async readInvoice(ref) {
    await this.visit(`/invoices/${ref}`);
    const fields = await this.readFields('#invoice');
    const shot = await this.snap(`readback-${ref}`);
    return { ...fields, shot };
  }

  async schedulePayment(ref) {
    await this.visit(`/invoices/${ref}`);
    await this.click(this.page.getByRole('button', { name: 'Schedule for payment run' }), 'Schedule for payment run');
    const fields = await this.readFields('#invoice');
    const shot = await this.snap(`scheduled-${ref}`);
    return { ...fields, shot };
  }
}
