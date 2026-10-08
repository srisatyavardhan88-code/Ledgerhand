// The evidence pack: a self-contained HTML page (plus a Markdown summary) in the run folder,
// with every decision, the checks behind it, the ERP read-backs and the screenshots.
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const usd = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const LABEL = { scheduled: 'Scheduled for payment', posted: 'Posted', held: 'On hold · dispute drafted', blocked: 'Blocked · escalated to Security', duplicate: 'Duplicate · skipped', reviewed: 'Checked (read-only)', out_of_scope: 'Out of scope', needs_attention: 'Needs attention' };

export function writeReport({ run, goal, cases, tasks, verification, memory, headline }) {
  const humans = run.events.filter((e) => e.type === 'human.response');
  const recoveries = run.events.filter((e) => e.type === 'recovery');
  const caseHtml = cases.map((c) => `
<section class="case ${c.outcome}">
  <header><div><h3>${esc(c.supplier)} · ${esc(c.fields?.number)}</h3><p>${esc(c.file)} · ${usd(c.amount)} · ${esc(c.fields?.po)}</p></div><span class="badge">${esc(LABEL[c.outcome] || c.outcome)}</span></header>
  ${c.decision ? `<p class="why"><b>Decision:</b> ${esc(c.decision.reason)}</p>` : c.outcomeNote ? `<p class="why">${esc(c.outcomeNote)}</p>` : ''}
  ${c.checks?.length ? `<table><tr><th>Check</th><th>Observed</th><th></th></tr>${c.checks.map((k) => `<tr><td>${esc(k.name)}</td><td>${esc(k.detail)}</td><td>${k.ok ? (k.severity === 'warn' ? '⚠︎' : '✓') : '✗'}</td></tr>`).join('')}</table>` : ''}
  ${c.approval ? `<p><b>Approval:</b> ${c.approval.rejected ? 'rejected' : esc(c.approval.ref)} by ${esc(c.approval.by)}${c.approval.approver ? ' (' + esc(c.approval.approver) + ')' : ''}</p>` : ''}
  ${c.apRef ? `<p><b>ERP record:</b> ${esc(c.apRef)}${c.payment ? ' · payment run ' + esc(c.payment) : ''}</p>` : ''}
  ${c.verification ? `<p><b>Read-back:</b> ${c.verification.checks.map((k) => `${k.ok ? '✓' : '✗'} ${esc(k.name)}`).join(' · ')}</p>` : ''}
  ${c.draft ? `<details><summary>Drafted email to ${esc(c.draft.to)}</summary><pre>${esc(c.draft.subject)}\n\n${esc(c.draft.body)}</pre></details>` : ''}
  ${c.evidenceShot || c.supplierRecord?.shot ? `<img src="${esc(c.evidenceShot || c.supplierRecord.shot)}" alt="ERP evidence">` : ''}
</section>`).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evidence · ${esc(run.id)}</title>
<style>
:root{--ink:#14202b;--mute:#5d6b78;--line:#dfe4e8;--ok:#1d7a4d;--warn:#a46a00;--bad:#b3261e;--paper:#fbfaf6}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 16px 64px}h1{font:600 28px/1.2 Georgia,serif;margin:0 0 6px}h2{font:600 19px Georgia,serif;margin:36px 0 10px}
.sub{color:var(--mute)}.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:12px 0}
.case{background:#fff;border:1px solid var(--line);border-left:5px solid var(--mute);border-radius:10px;padding:14px 18px;margin:14px 0}
.case.scheduled,.case.posted{border-left-color:var(--ok)}.case.held,.case.duplicate{border-left-color:var(--warn)}.case.blocked,.case.needs_attention{border-left-color:var(--bad)}
.case header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.case h3{margin:0;font-size:16px}.case header p{margin:2px 0 0;color:var(--mute);font-size:13px}
.badge{font-size:12px;padding:3px 10px;border-radius:99px;background:#eef1f3;white-space:nowrap}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}td,th{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
img{max-width:100%;border:1px solid var(--line);border-radius:6px;margin-top:8px}pre{white-space:pre-wrap;background:#f4f3ee;padding:10px;border-radius:6px;font-size:13px}
.why{margin:8px 0}ol{padding-left:20px}li{margin:3px 0}code{font-size:12px;background:#eef1f3;padding:1px 5px;border-radius:4px}
</style></head><body><main>
<p class="sub">Ledgerhand evidence pack · ${esc(run.id)} · ${new Date().toUTCString()}</p>
<h1>${esc(headline)}</h1>
<div class="card"><b>Request:</b> “${esc(run.request)}”<br><b>Understood as:</b> ${esc(goal.summary)}<br>
<b>Assumptions:</b> ${goal.assumptions.map(esc).join(' ')}</div>
<h2>Verification against the ERP register</h2>
<div class="card">${verification ? `<table><tr><th>Invoice</th><th>Expected</th><th>Found in ERP</th><th></th></tr>${verification.rows.map((r) => `<tr><td>${esc(r.invoice)}</td><td>${esc(r.expected)}</td><td>${esc(r.found)}</td><td>${r.ok ? '✓' : '✗'}</td></tr>`).join('')}</table>` : 'Not run.'}</div>
<h2>Invoices</h2>${caseHtml}
<h2>Human decisions</h2><div class="card">${humans.length ? `<ol>${humans.map((h) => `<li>${esc(h.id)}: <b>${esc(h.decision)}</b> by ${esc(h.by)} at ${esc(h.at)}</li>`).join('')}</ol>` : 'None needed.'}</div>
<h2>Recoveries</h2><div class="card">${recoveries.length ? `<ol>${recoveries.map((r) => `<li><b>${esc(r.strategy.replace(/_/g, ' '))}</b>: ${esc(r.why)}</li>`).join('')}</ol>` : 'No failures.'}</div>
<h2>What I learned (memory)</h2><div class="card">${Object.keys(memory).length ? `<table>${Object.entries(memory).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v.value)}</td><td>${esc(v.source)}</td></tr>`).join('')}</table>` : 'Nothing new.'}</div>
<h2>Full plan as executed</h2><div class="card"><ol>${tasks.map((t) => `<li>[${t.status}] ${esc(t.title)} <span class="sub">· ${esc(t.tool)}${t.attempts > 1 ? ` · ${t.attempts} attempts` : ''}</span></li>`).join('')}</ol>
<p class="sub">Raw journal: <code>journal.jsonl</code> · screenshots: <code>shots/</code> · drafts: <code>outbox/</code></p></div>
</main></body></html>`;
  fs.writeFileSync(path.join(run.dir, 'report.html'), html);

  const md = [`# ${headline}`, '', `Request: “${run.request}”`, '', '| Invoice | Amount | Outcome | ERP |', '|---|---|---|---|',
    ...cases.map((c) => `| ${c.supplier} ${c.fields?.number ?? ''} | ${usd(c.amount)} | ${LABEL[c.outcome] || c.outcome} | ${c.apRef || '—'} |`), '',
    `Verified in ERP: ${verification ? verification.rows.filter((r) => r.ok).length + '/' + verification.rows.length : 'n/a'}`,
    `Recoveries: ${recoveries.map((r) => r.strategy).join(', ') || 'none'}`, `Human decisions: ${humans.length}`].join('\n');
  fs.writeFileSync(path.join(run.dir, 'report.md'), md + '\n');
  return 'report.html';
}
