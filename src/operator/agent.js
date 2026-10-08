// The operator loop: Goal → Understand → Plan → Execute → Observe → Adapt → Verify → Complete.
//
// The plan is a live task queue. Tasks are small, typed, and bound to a tool with a declared
// risk level. Observations can grow the plan (discovering invoices spawns per-invoice work; a
// match result spawns the actions that disposition needs), failures insert recovery tasks in
// front of the failed one, and risky steps pause on a human. Nothing is "done" until it has
// been read back from the system of record.
import fs from 'node:fs';
import path from 'node:path';
import { understand } from './understand.js';
import { extractInvoice } from './extract.js';
import { threeWayMatch } from './policy.js';
import { ErpSession } from './erp.js';
import { planRecovery, classify } from './recovery.js';
import { writeReport } from './report.js';

const MAX_ATTEMPTS = 4;
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Tool registry: what each task kind uses, which system it touches, and its risk.
export const TOOLS = {
  'context.read': { tool: 'Company handbook', system: 'files', risk: 'read' },
  'inbox.scan': { tool: 'File system', system: 'files', risk: 'read' },
  'invoice.extract': { tool: 'PDF reader', system: 'files', risk: 'read' },
  'erp.login': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'read' },
  'erp.dismissDialog': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'read' },
  'erp.duplicateCheck': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'read' },
  'erp.supplier': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'read' },
  'erp.purchaseOrder': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'read' },
  'erp.receipts': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'read' },
  'policy.match': { tool: 'AP policy engine', system: 'policy', risk: 'read' },
  'human.approval': { tool: 'Approval request', system: 'human', risk: 'read' },
  'human.decide': { tool: 'Ask a person', system: 'human', risk: 'read' },
  'erp.post': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'write', permission: 'post_invoice' },
  'erp.hold': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'write', permission: 'post_invoice' },
  'erp.schedule': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'write', permission: 'schedule_payment' },
  'erp.verify': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'read' },
  'mail.draft': { tool: 'Outbox (drafts only)', system: 'mail', risk: 'write', permission: 'draft_email' },
  'verify.final': { tool: 'Browser · Northwind Ledger', system: 'browser', risk: 'read' },
  'report.write': { tool: 'Evidence pack', system: 'files', risk: 'write', permission: 'write_report' },
  wait: { tool: 'Clock', system: 'runtime', risk: 'read' },
};

export class Operator {
  constructor({ run, ctx, memory, pace = 0 }) {
    Object.assign(this, { run, ctx, memory, pace });
    this.tasks = [];
    this.cases = new Map();
    this.seq = 0;
    this.erp = new ErpSession({ run, ctx, memory });
  }

  // ---- plan management --------------------------------------------------------------------
  task(kind, title, args = {}, caseId = null) {
    return { id: `T${++this.seq}`, kind, title, args, caseId, status: 'pending', attempts: 0, ...TOOLS[kind] };
  }
  add(tasks, { front = false, after = null } = {}) {
    if (after) this.tasks.splice(this.tasks.indexOf(after) + 1, 0, ...tasks);
    else if (front) {
      const i = this.tasks.findIndex((t) => t.status === 'pending');
      this.tasks.splice(i < 0 ? this.tasks.length : i, 0, ...tasks);
    } else this.tasks.push(...tasks);
    this.publishPlan();
  }
  publishPlan() {
    this.run.emitEvent('plan', { tasks: this.tasks.map(({ id, kind, title, status, caseId, tool, system, risk, attempts }) => ({ id, kind, title, status, caseId, tool, system, risk, attempts })) });
  }
  setStatus(t, status) { t.status = status; this.publishPlan(); }
  phase(name, detail) { this.run.emitEvent('phase', { phase: name, detail }); }
  updateCase(id, patch) {
    const c = Object.assign(this.cases.get(id), patch);
    this.run.emitEvent('case', { case: publicCase(c) });
    return c;
  }

  // ---- the loop ---------------------------------------------------------------------------
  async execute() {
    const { run, ctx } = this;
    try {
      this.phase('understand', 'Reading the request against company policy');
      this.goal = await understand(run.request, ctx);
      run.emitEvent('goal', { goal: this.goal });
      if (this.goal.intent === 'unsupported') {
        run.emitEvent('complete', { outcome: 'needs_input', summary: this.goal.clarify });
        run.status = 'needs_input';
        return;
      }

      this.phase('plan', 'Drafting an initial plan; it will grow as I learn what is in the inbox');
      this.add([
        this.task('context.read', 'Read AP procedure, policy and approver directory'),
        this.task('inbox.scan', 'Find invoices waiting in the AP inbox'),
        this.task('erp.login', 'Sign in to Northwind Ledger with the operator service account'),
        this.task('verify.final', 'Verify every outcome against the ERP register'),
        this.task('report.write', 'Assemble the evidence pack'),
      ]);
      await this.erp.start();

      let t;
      while ((t = this.tasks.find((x) => x.status === 'pending'))) await this.step(t);

      const failed = this.tasks.filter((x) => x.status === 'failed');
      run.status = failed.length ? 'completed_with_issues' : 'completed';
      this.phase('complete', this.headline());
      run.emitEvent('complete', { outcome: run.status, summary: this.headline(), report: this.reportRel });
    } catch (e) {
      run.status = 'crashed';
      run.emitEvent('complete', { outcome: 'crashed', summary: `Stopped: ${e.message}` });
    } finally {
      await this.erp.stop();
    }
  }

  async step(t) {
    const { run } = this;
    // Guardrail: write actions must be on the operator's permission list in company policy.
    if (t.permission) {
      const perms = this.ctx.policy.permissions.operator;
      if (!perms.allowed.includes(t.permission) || perms.forbidden.includes(t.permission)) {
        run.emitEvent('guardrail', { taskId: t.id, permission: t.permission, allowed: false });
        this.setStatus(t, 'failed');
        return;
      }
      run.emitEvent('guardrail', { taskId: t.id, permission: t.permission, allowed: true });
    }
    t.attempts += 1;
    this.setStatus(t, 'running');
    if (this.pace) await new Promise((r) => setTimeout(r, this.pace));
    this.phase('execute', t.title);
    run.emitEvent('task.start', { taskId: t.id, title: t.title, tool: t.tool, system: t.system, risk: t.risk, attempt: t.attempts, caseId: t.caseId });
    try {
      const result = await this.handlers[t.kind].call(this, t);
      t.result = result;
      this.phase('observe', result?.observation);
      run.emitEvent('task.observe', { taskId: t.id, observation: result?.observation, shot: result?.shot, data: result?.data });
      if (result?.spawn?.length) {
        this.phase('adapt', `Plan updated: +${result.spawn.length} step${result.spawn.length > 1 ? 's' : ''} (${result.why || 'new information'})`);
        const anchor = result.placement === 'beforeVerify' ? this.tasks[this.tasks.findIndex((x) => x.kind === 'verify.final') - 1] : t;
        this.add(result.spawn, { after: anchor });
      }
      this.setStatus(t, result?.skipped ? 'skipped' : 'done');
    } catch (err) {
      await this.recover(t, err);
    }
  }

  async recover(t, err) {
    const { run } = this;
    const plan = planRecovery(err, t, this.memory);
    this.phase('adapt', `${t.title} failed (${classify(err).replace(/_/g, ' ')}). Strategy: ${plan.strategy.replace(/_/g, ' ')}`);
    run.emitEvent('task.error', { taskId: t.id, error: String(err.message).split('\n')[0].slice(0, 240), kind: classify(err), shot: err.shot });
    run.emitEvent('recovery', { taskId: t.id, strategy: plan.strategy, why: plan.why });
    if (plan.learn) {
      this.memory.set(plan.learn[0], plan.learn[1], `${run.id}: learned from ERP validation message`);
      run.emitEvent('memory', { key: plan.learn[0], value: plan.learn[1], facts: this.memory.all() });
    }
    if (plan.adopt) {
      const adopted = await this.adoptExisting(t, plan.adopt);
      if (adopted) return;
    }
    if (plan.retry && t.attempts < MAX_ATTEMPTS) {
      this.setStatus(t, 'pending');
      this.add(plan.before.map((b) => this.task(b.kind, b.title, b.args || {}, t.caseId)), { front: true });
      return;
    }
    // Out of ideas: ask a person instead of guessing.
    const answer = await this.run.ask({
      kind: 'help', title: `I'm stuck: ${t.title}`, caseId: t.caseId,
      body: plan.why, error: String(err.message).slice(0, 300), shot: err.shot,
      options: [{ value: 'retry', label: 'Try again' }, { value: 'skip', label: 'Skip this step' }],
    });
    this.phase('adapt', answer.decision === 'retry' ? 'Retrying at your request' : 'Skipping at your request');
    if (answer.decision === 'retry') { t.attempts = 0; this.setStatus(t, 'pending'); }
    else {
      this.setStatus(t, 'failed');
      if (t.caseId) this.updateCase(t.caseId, { outcome: 'needs_attention', outcomeNote: `Stopped at “${t.title}”: ${plan.why}` });
    }
  }

  // The ERP refused an entry as a duplicate. If the existing record was created by us in an
  // earlier attempt that we lost track of (e.g. the session dropped after submit), adopt it.
  async adoptExisting(t, ref) {
    const c = this.cases.get(t.caseId);
    if (!c || c.duplicates?.length) return false;
    const rec = await this.erp.readInvoice(ref);
    const ours = rec.number === c.fields.number && Math.abs(Number(rec.amount.replace(/[$,]/g, '')) - c.fields.total) < 0.01;
    if (!ours) return false;
    this.run.emitEvent('task.observe', { taskId: t.id, observation: `${ref} is the record from my earlier attempt. Adopting it instead of entering a duplicate.`, shot: rec.shot });
    this.updateCase(c.id, { apRef: ref });
    t.result = { ref };
    this.setStatus(t, 'done');
    return true;
  }

  headline() {
    const counts = {};
    for (const c of this.cases.values()) counts[c.outcome || 'open'] = (counts[c.outcome || 'open'] || 0) + 1;
    return Object.entries(counts).map(([k, v]) => `${v} ${OUTCOME_LABEL[k] || k}`).join(' · ');
  }

  // ---- task handlers ----------------------------------------------------------------------
  handlers = {
    async 'context.read'() {
      const { policy, sop } = this.ctx;
      const rules = sop.split('\n').filter((l) => /^## /.test(l)).map((l) => l.replace(/^## \d+\.\s*/, ''));
      return { observation: `AP-SOP-04 has ${rules.length} stages (${rules.join(' → ')}). Tolerance ${policy.ap.priceTolerancePct}%, approval above ${usd(policy.ap.approvalThreshold)}. Learned facts in memory: ${Object.keys(this.memory.all()).length || 'none yet'}.`, data: { rules, memory: this.memory.all() } };
    },

    async 'inbox.scan'() {
      const files = fs.readdirSync(this.ctx.inboxDir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
      const spawn = [];
      for (const f of files) {
        const id = f.replace(/\.pdf$/i, '');
        this.cases.set(id, { id, file: f, status: 'queued', checks: [], evidence: [] });
        this.run.emitEvent('case', { case: publicCase(this.cases.get(id)) });
        spawn.push(this.task('invoice.extract', `Read ${f}`, { file: f }, id));
      }
      return { observation: `${files.length} PDFs in the AP inbox.`, spawn, placement: 'beforeVerify', why: 'one work item per invoice', data: { files } };
    },

    async 'erp.login'() {
      const r = await this.erp.login();
      return { observation: `Signed in as ${r.user}; landed on ${r.landedOn}.`, shot: r.shot };
    },

    async 'erp.dismissDialog'() {
      const r = await this.erp.dismissDialog();
      return { observation: r.dismissed ? `Dialog said: “${r.dialogText.slice(0, 140)}”. Pressed “${r.pressed}”.` : r.note, shot: r.shot };
    },

    async wait(t) {
      await new Promise((r) => setTimeout(r, t.args.ms));
      return { observation: `Waited ${t.args.ms}ms.` };
    },

    async 'invoice.extract'(t) {
      const c = this.cases.get(t.caseId);
      const { fields } = await extractInvoice(path.join(this.ctx.inboxDir, t.args.file));
      this.updateCase(c.id, { status: 'reading', fields, supplier: fields.supplier, amount: fields.total });
      const scope = this.goal.scope.vendors;
      if (scope.length && !scope.some((v) => fields.supplier?.toLowerCase().includes(v.toLowerCase()))) {
        this.updateCase(c.id, { outcome: 'out_of_scope', status: 'done', outcomeNote: `Not in requested scope (${scope.join(', ')})` });
        return { observation: `${fields.supplier} is outside the requested scope; leaving it untouched.`, skipped: true };
      }
      if (fields.confidence < 1) {
        const failed = fields.checks.filter((x) => !x.ok).map((x) => x.name).join(', ');
        const a = await this.run.ask({ kind: 'help', title: `Can't read ${t.args.file} reliably`, caseId: c.id, body: `My reader is unsure (${failed}).`, options: [{ value: 'skip', label: 'Skip it' }] });
        this.updateCase(c.id, { outcome: 'needs_attention', outcomeNote: 'Unreadable invoice', decidedBy: a.by });
        return { observation: 'Unreadable invoice; left for a person.', skipped: true };
      }
      const id = c.id;
      return {
        observation: `${fields.supplier} ${fields.number}, ${usd(fields.total)}, ${fields.po}, dated ${fields.dateRaw} → ${fields.date}. ${fields.lines.length} line(s); all self-checks pass.${fields.notes.length ? ' Note on invoice: “' + fields.notes[0] + '”' : ''}`,
        data: { fields },
        spawn: [
          this.task('erp.duplicateCheck', `Check register for ${fields.number}`, {}, id),
          this.task('erp.supplier', `Verify ${fields.supplier} supplier master`, {}, id),
          this.task('erp.purchaseOrder', `Open ${fields.po}`, {}, id),
          this.task('erp.receipts', `Find goods receipts for ${fields.po}`, {}, id),
          this.task('policy.match', `Three-way match ${fields.number}`, {}, id),
        ],
        why: 'AP-SOP-04 steps 2–4 for this invoice',
      };
    },

    async 'erp.duplicateCheck'(t) {
      const c = this.cases.get(t.caseId);
      const r = await this.erp.searchRegister(c.fields.number);
      const dups = r.rows.filter((row) => row.Supplier === c.fields.supplier);
      // The same invoice can also sit in the inbox twice. The ERP only catches that once the
      // first copy is posted, so a dry run (or a held first copy) needs this check as well.
      const twin = [...this.cases.values()].find((o) => o !== c && o.fields && o.outcome !== 'out_of_scope' && o.decision && o.fields.supplier === c.fields.supplier && o.fields.number.toLowerCase() === c.fields.number.toLowerCase());
      if (!dups.length && twin) dups.push({ 'AP ref': `${twin.file} in this inbox`, Status: 'already being processed' });
      this.updateCase(c.id, { duplicates: dups, status: 'checking' });
      return { observation: dups.length ? `Already ${twin && !r.rows.length ? 'handled' : 'in the ERP'} as ${dups.map((d) => `${d['AP ref']} (${d.Status})`).join(', ')}.` : `No existing record for ${c.fields.number}.`, shot: r.shot };
    },

    async 'erp.supplier'(t) {
      const c = this.cases.get(t.caseId);
      const s = await this.erp.readSupplier(c.fields.supplier);
      this.updateCase(c.id, { supplierRecord: s });
      return { observation: `${s.id}: master IBAN …${s.bank.replace(/\s/g, '').slice(-4)}, invoice IBAN …${c.fields.iban.replace(/\s/g, '').slice(-4)}.`, shot: s.shot };
    },

    async 'erp.purchaseOrder'(t) {
      const c = this.cases.get(t.caseId);
      const po = await this.erp.readPurchaseOrder(c.fields.po);
      this.updateCase(c.id, { poRecord: po });
      return { observation: `${po.po} (${po.status}) for ${po.vendorId}: ${po.lines.map((l) => `${l.qty}× ${l.sku} @ ${usd(l.price)}`).join(', ')}.`, shot: po.shot };
    },

    async 'erp.receipts'(t) {
      const c = this.cases.get(t.caseId);
      const r = await this.erp.readReceipts(c.fields.po);
      this.updateCase(c.id, { receiptRecord: r });
      return { observation: r.grns.length ? `${r.grns.join(', ')}: received ${Object.entries(r.received).map(([k, v]) => `${v}× ${k}`).join(', ')}.` : 'No goods receipt yet.', shot: r.shot };
    },

    async 'policy.match'(t) {
      const c = this.cases.get(t.caseId);
      const d = threeWayMatch({ invoice: c.fields, supplier: c.supplierRecord, po: c.poRecord, receipts: c.receiptRecord, duplicates: c.duplicates, policy: this.ctx.policy, goal: this.goal });
      this.updateCase(c.id, { decision: d, checks: d.checks, status: 'decided' });
      this.run.emitEvent('decision', { caseId: c.id, decision: d });
      const spawn = this.planActions(c, d);
      return { observation: `${DECISION_LABEL[d.action]}: ${d.reason}`, spawn, why: `disposition “${DECISION_LABEL[d.action]}”` };
    },

    async 'human.approval'(t) {
      const c = this.cases.get(t.caseId);
      const d = c.decision;
      const approver = t.args.userReview ? { name: 'You', title: 'requester' } : this.ctx.person(this.ctx.policy.ap.approver);
      const shot = c.supplierRecord?.shot;
      const answer = await this.run.ask({
        kind: 'approval', caseId: c.id, approver: approver.name, approverTitle: approver.title,
        title: `Approve posting ${c.fields.supplier} ${c.fields.number} for ${usd(c.fields.total)}?`,
        body: t.args.userReview ? `You asked to review anything above ${usd(this.goal.reviewAbove)}.` : `Above the ${usd(this.ctx.policy.ap.approvalThreshold)} auto-post limit (AP-SOP-04 §5).`,
        facts: d.checks.map((x) => ({ label: x.name, value: x.detail, ok: x.ok })), shot,
        options: [{ value: 'approve', label: 'Approve' }, { value: 'reject', label: 'Reject and hold' }],
      });
      if (answer.decision === 'approve') {
        const ref = `APR-${String(Date.now()).slice(-6)}`;
        this.updateCase(c.id, { approval: { ref, by: answer.by, approver: approver.name } });
        return { observation: `Approved by ${answer.by}. Approval reference ${ref}.` };
      }
      this.updateCase(c.id, { approval: { rejected: true, by: answer.by } });
      // The plan changes: drop the posting steps, park the invoice on hold instead.
      for (const x of this.tasks) if (x.caseId === c.id && x.status === 'pending') x.status = 'cancelled';
      return {
        observation: `Rejected by ${answer.by}. Parking the invoice on hold instead of posting.`,
        spawn: [this.task('erp.hold', `Park ${c.fields.number} on hold (approval rejected)`, { reason: 'Approval rejected' }, c.id), this.task('erp.verify', `Read back ${c.fields.number} from the ERP`, {}, c.id)],
        why: 'approval rejected',
      };
    },

    async 'human.decide'(t) {
      const c = this.cases.get(t.caseId);
      const a = await this.run.ask({ kind: 'help', caseId: c.id, title: `How should I handle ${c.fields.supplier} ${c.fields.number}?`, body: c.decision.reason,
        facts: c.decision.checks.map((x) => ({ label: x.name, value: x.detail, ok: x.ok })),
        options: [{ value: 'hold', label: 'Park it on hold' }, { value: 'leave', label: 'Leave it for me' }] });
      if (a.decision === 'leave') { this.updateCase(c.id, { outcome: 'needs_attention', outcomeNote: c.decision.reason }); return { observation: 'Left for a person, as asked.' }; }
      c.decision.matchStatus = 'Quantity exception';
      return { observation: 'Parking on hold, as asked.', spawn: [this.task('erp.hold', `Park ${c.fields.number} on hold`, { reason: c.decision.reason }, c.id), this.task('erp.verify', `Read back ${c.fields.number} from the ERP`, {}, c.id)] };
    },

    async 'erp.post'(t) {
      const c = this.cases.get(t.caseId);
      const d = c.decision;
      const r = await this.erp.enterInvoice({ supplier: c.supplierRecord.name, number: c.fields.number, po: c.fields.po, date: c.fields.date, amount: c.fields.total, match: d.matchStatus, approval: c.approval?.ref, notes: `${d.notes} Entered by Ledgerhand (${this.run.id}).` }, 'post');
      this.updateCase(c.id, { apRef: r.ref, status: 'posted' });
      return { observation: `ERP accepted the invoice as ${r.ref}.`, shot: r.shot };
    },

    async 'erp.hold'(t) {
      const c = this.cases.get(t.caseId);
      const d = c.decision;
      const r = await this.erp.enterInvoice({ supplier: c.supplierRecord.name, number: c.fields.number, po: c.fields.po, date: c.fields.date, amount: c.fields.total, match: d.matchStatus || 'Quantity exception', notes: `ON HOLD: ${t.args.reason || d.reason} Entered by Ledgerhand (${this.run.id}).` }, 'hold');
      this.updateCase(c.id, { apRef: r.ref, status: 'held' });
      return { observation: `Parked on hold as ${r.ref}.`, shot: r.shot };
    },

    async 'erp.schedule'(t) {
      const c = this.cases.get(t.caseId);
      const r = await this.erp.schedulePayment(c.apRef);
      this.updateCase(c.id, { payment: r.payment, status: 'scheduled' });
      return { observation: `${c.apRef} scheduled for the payment run on ${r.payment}.`, shot: r.shot };
    },

    // Read-back verification: what the ERP now says must equal what we intended.
    async 'erp.verify'(t) {
      const c = this.cases.get(t.caseId);
      const rec = await this.erp.readInvoice(c.apRef);
      const expectStatus = { scheduled: 'Scheduled', posted: 'Posted', held: 'On hold' }[c.status];
      const checks = [
        { name: 'Supplier invoice number', ok: rec.number === c.fields.number, detail: rec.number },
        { name: 'Gross amount', ok: Math.abs(Number(rec.amount.replace(/[$,]/g, '')) - c.fields.total) < 0.01, detail: rec.amount },
        { name: 'Purchase order', ok: rec.po === c.fields.po, detail: rec.po },
        { name: 'Status', ok: rec.status === expectStatus, detail: `${rec.status} (expected ${expectStatus})` },
      ];
      if (c.approval?.ref) checks.push({ name: 'Approval reference recorded', ok: rec.approval === c.approval.ref, detail: rec.approval });
      if (c.status === 'scheduled') checks.push({ name: 'Payment run date set', ok: /^\d{4}-\d{2}-\d{2}$/.test(rec.payment), detail: rec.payment });
      const ok = checks.every((x) => x.ok);
      const outcome = ok ? (c.status === 'held' ? 'held' : c.status) : 'needs_attention';
      this.updateCase(c.id, { verification: { checks, ok, shot: rec.shot }, outcome, evidenceShot: rec.shot });
      if (!ok) throw new Error(`Read-back mismatch on ${c.apRef}: ${checks.filter((x) => !x.ok).map((x) => x.name).join(', ')}`);
      return { observation: `Read back ${c.apRef}: ${checks.length}/${checks.length} fields match. Status “${rec.status}”.`, shot: rec.shot };
    },

    async 'mail.draft'(t) {
      const c = this.cases.get(t.caseId);
      const { to, subject, body } = t.args;
      fs.mkdirSync(this.ctx.outboxDir, { recursive: true });
      const name = `${this.run.id}-${c.id}.eml`;
      const eml = `From: ap-operator@northwind.example\nTo: ${to}\nSubject: ${subject}\nX-Ledgerhand-Status: DRAFT (not sent; requires human send)\n\n${body}\n`;
      fs.writeFileSync(path.join(this.ctx.outboxDir, name), eml);
      fs.mkdirSync(path.join(this.run.dir, 'outbox'), { recursive: true });
      fs.writeFileSync(path.join(this.run.dir, 'outbox', name), eml);
      this.updateCase(c.id, { draft: { to, subject, body, file: `outbox/${name}` } });
      if (c.decision.action === 'block_escalate') this.updateCase(c.id, { outcome: 'blocked', status: 'escalated' });
      return { observation: `Drafted “${subject}” to ${to}. Saved to the outbox for a person to send.` };
    },

    async 'verify.final'() {
      const rows = [];
      for (const c of this.cases.values()) {
        if (!c.fields || c.outcome === 'out_of_scope') continue;
        const r = await this.erp.searchRegister(c.fields.number);
        const mine = r.rows.filter((x) => x.Supplier === c.fields.supplier);
        const expect = {
          scheduled: (m) => m.length === 1 && m[0].Status === 'Scheduled',
          posted: (m) => m.length === 1 && m[0].Status === 'Posted',
          held: (m) => m.length === 1 && m[0].Status === 'On hold',
          blocked: (m) => m.length === 0,
          duplicate: (m) => m.length <= 1,
          reviewed: (m) => m.length === 0,
        }[c.outcome];
        const ok = expect ? expect(mine) : false;
        rows.push({ caseId: c.id, invoice: `${c.fields.supplier} ${c.fields.number}`, expected: OUTCOME_LABEL[c.outcome] || c.outcome, found: mine.length ? mine.map((m) => `${m['AP ref']} ${m.Status}`).join(', ') : 'no record', ok, shot: r.shot });
        this.updateCase(c.id, { finalCheck: { ok, found: rows.at(-1).found } });
      }
      const allOk = rows.every((r) => r.ok);
      this.verification = { rows, allOk };
      this.phase('verify', allOk ? `All ${rows.length} invoices verified in the ERP register` : 'Some outcomes do not match the ERP');
      this.run.emitEvent('verify', { rows, allOk });
      return { observation: `${rows.filter((r) => r.ok).length}/${rows.length} outcomes confirmed in the ERP register.` };
    },

    async 'report.write'() {
      const rel = writeReport({ run: this.run, goal: this.goal, cases: [...this.cases.values()], tasks: this.tasks, verification: this.verification, memory: this.memory.all(), headline: this.headline() });
      this.reportRel = rel;
      return { observation: `Evidence pack written: ${rel}.`, data: { report: rel } };
    },
  };

  // Turn a disposition into concrete steps, respecting what the user asked for.
  planActions(c, d) {
    const T = (k, title, args = {}) => this.task(k, title, args, c.id);
    const n = c.fields.number;
    if (d.action === 'skip_duplicate') { this.updateCase(c.id, { outcome: 'duplicate', status: 'done' }); return []; }
    if (d.action === 'block_escalate') {
      const sec = this.ctx.byRole('fraud_escalation');
      return [T('mail.draft', `Draft fraud escalation to ${sec.name}`, {
        to: `${sec.id}@northwind.example`, subject: `[Possible payment fraud] ${c.fields.supplier} ${n}: bank details changed`,
        body: `Hi ${sec.name.split(' ')[0]},\n\nI stopped processing ${c.fields.supplier} invoice ${n} (${usd(c.fields.total)}, ${c.fields.po}).\n\nThe invoice asks for payment to IBAN ${c.fields.iban}, but the supplier master holds ${c.supplierRecord.bank}.\nThe invoice also says: "${c.fields.notes[0] || '—'}".\n\nI have not posted or paid it and have not changed the supplier record. Please verify the change with the supplier through a known contact before anything is paid.\n\nEvidence: run ${this.run.id}\n— Ledgerhand (AP operator)`,
      })];
    }
    if (d.action === 'ask_human') return [T('human.decide', `Ask how to handle ${n}`)];
    if (!this.goal.actions.post) { this.updateCase(c.id, { outcome: 'reviewed', status: 'done', outcomeNote: `Read-only run. Would ${DECISION_LABEL[d.action].toLowerCase()}${d.needsApproval ? ' after CFO approval' : ''}.` }); return []; }
    if (d.action === 'hold_dispute') {
      return [
        T('erp.hold', `Park ${n} on hold (quantity exception)`),
        T('erp.verify', `Read back ${n} from the ERP`),
        T('mail.draft', `Draft credit-note request to ${c.fields.supplier}`, {
          to: c.supplierRecord.email, subject: `Credit note request: invoice ${n} / ${c.fields.po}`,
          body: `Hello,\n\nThank you for invoice ${n} (${usd(c.fields.total)}).\n\n${d.qtyProblems.map((q) => `${q.desc}: invoiced ${q.billed}, but our goods receipt shows ${q.received} delivered.`).join('\n')}\n\nCould you please issue a credit note for ${usd(d.creditNote)} (or a corrected invoice)? We have placed the invoice on hold until then.\n\nKind regards,\nNorthwind Trading Co. — Accounts Payable`,
        }),
      ];
    }
    // post
    const steps = [];
    if (d.needsApproval || d.userReview) steps.push(T('human.approval', `Get ${d.needsApproval ? 'CFO' : 'your'} approval for ${n}`, { userReview: !d.needsApproval }));
    steps.push(T('erp.post', `Post ${n} as “${d.matchStatus}”`));
    if (this.goal.actions.schedule) steps.push(T('erp.schedule', `Schedule ${n} for the payment run`));
    steps.push(T('erp.verify', `Read back ${n} from the ERP`));
    return steps;
  }

}

export const DECISION_LABEL = { post: 'Post', skip_duplicate: 'Skip duplicate', block_escalate: 'Block & escalate', hold_dispute: 'Hold & dispute', ask_human: 'Needs a person' };
export const OUTCOME_LABEL = { scheduled: 'scheduled for payment', posted: 'posted', held: 'held', blocked: 'blocked as suspected fraud', duplicate: 'duplicate skipped', reviewed: 'checked (read-only)', out_of_scope: 'out of scope', needs_attention: 'need attention', open: 'open' };

function publicCase(c) {
  const { id, file, status, outcome, outcomeNote, supplier, amount, fields, decision, apRef, approval, payment, verification, draft, checks, finalCheck, evidenceShot } = c;
  return { id, file, status, outcome, outcomeNote, supplier, amount, number: fields?.number, po: fields?.po, decision: decision && { action: decision.action, reason: decision.reason, matchStatus: decision.matchStatus }, apRef, approval, payment, verification, draft, checks, finalCheck, evidenceShot };
}
