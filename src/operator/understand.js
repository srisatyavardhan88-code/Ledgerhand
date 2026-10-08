// Understand: turn a short, under-specified request into an explicit goal with scope,
// permitted actions, constraints and success criteria — filling the gaps from company policy
// and saying which assumptions were made.
import { askJson, llmEnabled } from './llm.js';

const STOP = new Set(['AP', 'I', 'Clear', 'Process', 'Please', 'Pay', 'Post', 'Handle', 'Run', 'Do', 'Check', 'Go', 'Friday', 'Monday', 'USD', 'CFO', 'ERP', 'PO', 'The', 'Only', 'Hold', 'Review', 'Make', 'Get', 'Book', 'Can', 'Then', 'Anything', 'Everything', 'Schedule', 'Don']);

export function interpret(request, ctx) {
  const text = request.trim();
  const lower = text.toLowerCase();
  const assumptions = [];

  const isAp = /(invoice|bill|payable|\bap\b|supplier|vendor|payment run)/i.test(text);
  if (!isAp) {
    return { intent: 'unsupported', summary: 'This request is outside what this operator is trained and permitted to do (supplier invoice processing).', clarify: 'I handle supplier invoices end to end, so I have not touched anything. Which invoices should I process?', scope: { vendors: [] }, actions: { post: false, schedule: false }, assumptions: [], constraints: [], successCriteria: [] };
  }

  const dryRun = /(dry[- ]run|don'?t (post|touch|change)|just (check|review|look)|report only|without posting)/i.test(text);
  const noPay = /(don'?t|do not|without) (pay|schedul)|post only|only post|but not pay/i.test(text);
  const wantsPay = /(pay|payment|schedul|clear)/i.test(text) && !noPay;

  const vendors = [...text.matchAll(/\b([A-Z][a-zA-Z]+)\b/g)].map((m) => m[1]).filter((w, i) => !(STOP.has(w) || (i === 0 && text.startsWith(w))));
  const scopedVendors = /\bonly\b|\bjust\b/i.test(text) && vendors.length ? [...new Set(vendors)] : [];

  let reviewAbove = null;
  const m = /(above|over|more than|greater than)\s*\$?\s*([\d,.]+)\s*(k\b)?/i.exec(text);
  if (m && /(hold|review|approv|check with|ask)/i.test(text)) reviewAbove = Number(m[2].replace(/,/g, '')) * (m[3] ? 1000 : 1);

  const threshold = ctx.policy.ap.approvalThreshold;
  const approver = ctx.person(ctx.policy.ap.approver);
  const constraints = [
    `Follow ${'AP-SOP-04'}: duplicate check, supplier bank verification, three-way match`,
    `Price tolerance ${ctx.policy.ap.priceTolerancePct}% vs PO; billed quantity ≤ received quantity`,
    `Invoices above $${threshold.toLocaleString()} need ${approver.name} (${approver.title}) approval`,
    'Never change supplier bank details; never send external email (drafts only)',
  ];
  if (reviewAbove != null) constraints.push(`You asked to review anything above $${reviewAbove.toLocaleString()} before it is posted`);

  if (!scopedVendors.length) assumptions.push('Scope is every invoice currently in the AP inbox.');
  if (wantsPay && !dryRun) assumptions.push(`"Pay" means schedule into the next ${ctx.policy.ap.paymentRunWeekday} payment run, not release funds now.`);
  if (!wantsPay && !dryRun) assumptions.push('Post invoices but leave payment scheduling to the AP team.');
  if (dryRun) assumptions.push('Read-only: check and report, change nothing in the ERP.');

  const successCriteria = [
    'Every invoice in scope has exactly one disposition: posted, scheduled, held, blocked, or skipped as duplicate',
    'Every ERP change is read back from the ERP and matches what was intended',
    'Every exception has a drafted message to the right person',
    'An evidence pack with screenshots and the decision trail is produced',
  ];

  return {
    intent: 'process_supplier_invoices',
    summary: dryRun ? 'Check the supplier invoices in the AP inbox against the ERP and report, without changing anything.'
      : `Process ${scopedVendors.length ? scopedVendors.join(' and ') + ' ' : ''}supplier invoices from the AP inbox: verify, post${wantsPay ? ' and schedule for payment' : ''}, and route exceptions.`,
    scope: { source: 'AP inbox', vendors: scopedVendors },
    actions: { post: !dryRun, schedule: wantsPay && !dryRun },
    reviewAbove,
    constraints,
    assumptions,
    successCriteria,
  };
}

export async function understand(request, ctx) {
  const base = interpret(request, ctx);
  if (!llmEnabled() || base.intent === 'unsupported') return { ...base, interpreter: 'built-in' };
  try {
    const out = await askJson(
      'You turn short requests to an accounts-payable operator into structured goals. Fields: summary (string), vendors (array of supplier names the user limited scope to, else []), post (bool), schedule (bool: should posted invoices be scheduled for payment), reviewAbove (number or null: amount above which the user wants to review first), assumptions (array of strings).',
      `Request: ${request}`,
    );
    return { ...base, summary: out.summary || base.summary, scope: { ...base.scope, vendors: out.vendors || [] },
      actions: { post: Boolean(out.post), schedule: Boolean(out.schedule) && Boolean(out.post) },
      reviewAbove: out.reviewAbove ?? base.reviewAbove, assumptions: out.assumptions?.length ? out.assumptions : base.assumptions, interpreter: 'claude' };
  } catch (e) {
    return { ...base, interpreter: 'built-in', assumptions: [...base.assumptions, `(Claude unavailable: ${e.message.slice(0, 80)})`] };
  }
}
