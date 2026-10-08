// AP-SOP-04 as code. Financial controls should be deterministic and explainable, so the match
// and the disposition are computed here from what the operator observed, with every check kept
// as evidence. The loop decides *how* to carry the decision out; this decides *what* it is.

const normIban = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
const usd = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function resolveSku(lineText, poLines) {
  const hits = poLines.filter((l) => lineText.startsWith(l.sku)).sort((a, b) => b.sku.length - a.sku.length);
  return hits[0] || null;
}

export function threeWayMatch({ invoice, supplier, po, receipts, duplicates, policy, goal }) {
  const ap = policy.ap;
  const checks = [];
  const add = (name, ok, detail, severity = ok ? 'pass' : 'fail') => checks.push({ name, ok, detail, severity });

  add('Not already in the ERP register', duplicates.length === 0, duplicates.length ? `Already recorded as ${duplicates.map((d) => d['AP ref']).join(', ')}` : 'No existing record for this supplier invoice number');
  if (duplicates.length) return finish('skip_duplicate', 'Duplicate of an invoice already in the ERP or earlier in this inbox. Do not post it twice.');

  const bankOk = normIban(invoice.iban) === normIban(supplier.bank);
  add('Remittance bank matches supplier master', bankOk, bankOk ? `IBAN …${normIban(supplier.bank).slice(-4)}` : `Invoice says …${normIban(invoice.iban).slice(-4)}, master says …${normIban(supplier.bank).slice(-4)}`);
  if (!bankOk) return finish('block_escalate', 'Bank details on the invoice differ from the supplier master: possible payment-redirection fraud. Stop and escalate to Security.');

  add('PO belongs to this supplier', po.vendorId === supplier.id, `${po.po} → ${po.vendorId}`);
  if (po.vendorId !== supplier.id) return finish('ask_human', `${po.po} is not a purchase order for ${supplier.name}.`);

  let poPriced = 0;
  let qtyProblems = [];
  for (const line of invoice.lines) {
    const pl = resolveSku(line.text, po.lines);
    if (!pl) { add(`Line “${line.text.slice(0, 30)}” is on the PO`, false, 'No matching PO line'); return finish('ask_human', 'Invoice has a line that is not on the purchase order.'); }
    poPriced += line.qty * pl.price;
    const rec = receipts.received[pl.sku] || 0;
    const ok = line.qty <= rec + ap.quantityTolerance && line.qty <= pl.qty;
    add(`${pl.sku}: billed qty ≤ received qty`, ok, `billed ${line.qty}, ordered ${pl.qty}, received ${rec}`);
    if (!ok) qtyProblems.push({ sku: pl.sku, desc: pl.desc, billed: line.qty, received: rec, price: line.price });
  }
  const variance = invoice.total - poPriced;
  const variancePct = poPriced ? (variance / poPriced) * 100 : 0;
  const priceOk = variancePct <= ap.priceTolerancePct + 1e-9;
  add(`Price within ${ap.priceTolerancePct}% of PO`, priceOk, `${usd(invoice.total)} vs PO ${usd(poPriced)} (${variance >= 0 ? '+' : ''}${variancePct.toFixed(2)}%)`, priceOk ? (variance > 0.004 ? 'warn' : 'pass') : 'fail');

  if (qtyProblems.length) {
    const over = qtyProblems.reduce((s, q) => s + (q.billed - q.received) * q.price, 0);
    return finish('hold_dispute', `Billed for more than was received (${qtyProblems.map((q) => `${q.billed} billed vs ${q.received} received`).join('; ')}). Hold and ask the supplier for a credit note of ${usd(over)}.`, { matchStatus: 'Quantity exception', qtyProblems, creditNote: over });
  }
  if (!priceOk) return finish('ask_human', `Price variance ${variancePct.toFixed(2)}% exceeds the ${ap.priceTolerancePct}% tolerance.`);

  const matchStatus = variance > 0.004 ? 'Within tolerance' : '3-way matched';
  const notes = variance > 0.004 ? `Price variance +${variancePct.toFixed(2)}% (${usd(variance)}) within ${ap.priceTolerancePct}% tolerance per AP-SOP-04.` : 'Three-way matched to PO and goods receipt.';
  const needsApproval = invoice.total > ap.approvalThreshold;
  const userReview = goal.reviewAbove != null && invoice.total > goal.reviewAbove;
  add(`Within auto-post limit (${usd(ap.approvalThreshold)})`, true, needsApproval ? 'Above limit: routed to CFO for approval' : 'No approval needed', needsApproval ? 'warn' : 'pass');
  return finish('post', (matchStatus === 'Within tolerance' ? `Matches within tolerance (price +${variancePct.toFixed(2)}%).` : 'Clean three-way match.') + (needsApproval ? ` Above ${usd(ap.approvalThreshold)}, so CFO sign-off is needed before posting.` : userReview ? ' Above your review limit, so I will ask you first.' : ' Post it.'), { matchStatus, notes, needsApproval, userReview, variance, variancePct });

  function finish(action, reason, extra = {}) {
    return { action, reason, checks, ...extra };
  }
}
