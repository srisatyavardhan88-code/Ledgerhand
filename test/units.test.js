import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, parseInvoiceText } from '../src/operator/extract.js';
import { interpret } from '../src/operator/understand.js';
import { threeWayMatch } from '../src/operator/policy.js';
import { planRecovery, SessionExpired, ValidationError } from '../src/operator/recovery.js';
import { loadContext } from '../src/operator/context.js';

const ctx = loadContext();

test('dates in every supplier style normalise to ISO', () => {
  assert.equal(parseDate('2 October 2026'), '2026-10-02');
  assert.equal(parseDate('03.10.2026'), '2026-10-03');
  assert.equal(parseDate('2026-10-04'), '2026-10-04');
  assert.equal(parseDate('Oct 4, 2026'), '2026-10-04');
  assert.equal(parseDate('October 5, 2026'), '2026-10-05');
});

test('line items with glued text resolve by arithmetic', () => {
  const f = parseInvoiceText('Initech Hardware\nInvoice Number: IH-7731\nIssued: 2026-10-04\nPO Number: PO-24030\nWS-T7Engineering workstation T78$2,150.00$17,200.00\nMON-2727" monitor8$150.00$1,200.00\nTotal (USD): $18,400.00\nRemit to IBAN: NL91 ABNA 0417 1643 3318');
  assert.deepEqual(f.lines.map((l) => l.qty), [8, 8]);
  assert.equal(f.total, 18400);
  assert.equal(f.confidence, 1);
});

test('request interpretation fills gaps and respects limits', () => {
  const a = interpret("Clear this week's supplier invoices and get them into Friday's payment run", ctx);
  assert.equal(a.actions.post, true);
  assert.equal(a.actions.schedule, true);
  const b = interpret("Post the invoices in the AP inbox but don't schedule any payments", ctx);
  assert.equal(b.actions.schedule, false);
  const c = interpret('Only process the Acme and Globex invoices', ctx);
  assert.deepEqual(c.scope.vendors, ['Acme', 'Globex']);
  const d = interpret('Process the AP inbox, but hold anything over $3,000 for my review', ctx);
  assert.equal(d.reviewAbove, 3000);
  const e = interpret("Just check the AP inbox, don't post anything", ctx);
  assert.equal(e.actions.post, false);
  assert.equal(interpret('Book me a flight to Berlin', ctx).intent, 'unsupported');
});

const supplier = { id: 'V-1', name: 'S', bank: 'DE00 1234' };
const po = { po: 'PO-1', vendorId: 'V-1', lines: [{ sku: 'A', qty: 10, price: 100 }] };
const base = { supplier, po, receipts: { received: { A: 10 } }, duplicates: [], policy: ctx.policy, goal: { reviewAbove: null } };
const inv = (o) => ({ iban: 'DE00 1234', total: 1000, lines: [{ text: 'Awidget', qty: 10, price: 100, amount: 1000 }], ...o });

test('policy: clean, tolerance, quantity, bank, duplicate, approval', () => {
  assert.equal(threeWayMatch({ ...base, invoice: inv() }).matchStatus, '3-way matched');
  assert.equal(threeWayMatch({ ...base, invoice: inv({ total: 1015 }) }).matchStatus, 'Within tolerance');
  assert.equal(threeWayMatch({ ...base, invoice: inv({ total: 1050 }) }).action, 'ask_human');
  assert.equal(threeWayMatch({ ...base, receipts: { received: { A: 8 } }, invoice: inv() }).action, 'hold_dispute');
  assert.equal(threeWayMatch({ ...base, invoice: inv({ iban: 'LT99' }) }).action, 'block_escalate');
  assert.equal(threeWayMatch({ ...base, duplicates: [{ 'AP ref': 'AP-1' }], invoice: inv() }).action, 'skip_duplicate');
  const big = { ...base, po: { ...po, lines: [{ sku: 'A', qty: 10, price: 2000 }] }, invoice: inv({ total: 20000, lines: [{ text: 'A', qty: 10, price: 2000, amount: 20000 }] }) };
  assert.equal(threeWayMatch(big).needsApproval, true);
});

test('recovery strategies are chosen from what was observed', () => {
  const mem = { get: () => undefined };
  assert.equal(planRecovery(SessionExpired(), { attempts: 1 }, mem).strategy, 'reauthenticate');
  const r = planRecovery(ValidationError('Invoice date must be in DD/MM/YYYY format.'), { attempts: 1 }, mem);
  assert.equal(r.strategy, 'adapt_input');
  assert.deepEqual(r.learn, ['erp.dateFormat', 'DD/MM/YYYY']);
  assert.equal(planRecovery(ValidationError('Duplicate invoice: X is already recorded as AP-7001.'), { attempts: 1 }, mem).adopt, 'AP-7001');
  assert.equal(planRecovery(new Error('Click: <div class="modal-backdrop"> intercepts pointer events'), { attempts: 1 }, mem).strategy, 'dismiss_dialog');
});
