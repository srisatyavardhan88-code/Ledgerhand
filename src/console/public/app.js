const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const usd = (n) => (n == null ? '' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const PHASES = ['understand', 'plan', 'execute', 'observe', 'adapt', 'verify', 'complete'];
const PRESETS = [
  ['Clear the inbox', "Clear this week's supplier invoices from the AP inbox and get everything that checks out into Friday's payment run."],
  ['Post only, no payment', 'Post the supplier invoices in the AP inbox but don\'t schedule any payments yet.'],
  ['Only Acme & Globex', 'Only process the Acme and Globex invoices and schedule them for payment.'],
  ['Review above $3k', 'Process the AP inbox and pay what checks out, but hold anything over $3,000 for my review first.'],
  ['Dry run', 'Just check the AP inbox against the ERP and tell me what you would do. Don\'t post anything.'],
];
const OUTCOME = { scheduled: 'Scheduled', posted: 'Posted', held: 'On hold', blocked: 'Blocked', duplicate: 'Duplicate', reviewed: 'Checked', out_of_scope: 'Out of scope', needs_attention: 'Needs attention' };

let ctx = null;
let runId = null;
let source = null;
let state;

function freshState() {
  return { phase: null, counts: {}, tasks: [], cases: new Map(), shots: [], asks: new Map(), feed: [], goal: null, result: null, verify: null, freshMemory: null, currentCase: null };
}

// ---------------------------------------------------------------- boot
async function loadContext() {
  ctx = await (await fetch('/api/context')).json();
  $('#company').textContent = ctx.company;
  $('#erp-link').href = ctx.erpUrl;
  const llm = $('#llm-pill');
  llm.textContent = ctx.llm ? 'interpreter: Claude' : 'interpreter: built-in';
  llm.classList.toggle('on', ctx.llm);
  const people = Object.fromEntries(ctx.people.map((p) => [p.id, p]));
  $('#context-strip').innerHTML = [
    `<div class="ctx">AP inbox · <b>${ctx.inbox.length} PDFs</b></div>`,
    `<div class="ctx">Procedure · <b>AP-SOP-04</b></div>`,
    `<div class="ctx">Tolerance · <b>${ctx.policy.ap.priceTolerancePct}%</b></div>`,
    `<div class="ctx">Approval above · <b>${usd(ctx.policy.ap.approvalThreshold)}</b> → ${esc(people[ctx.policy.ap.approver]?.name)}</div>`,
    `<div class="ctx">Forbidden · <b>${ctx.policy.permissions.operator.forbidden.map((f) => f.replace(/_/g, ' ')).join(', ')}</b></div>`,
    `<div class="ctx">Memory · <b>${Object.keys(ctx.memory).length} learned fact${Object.keys(ctx.memory).length === 1 ? '' : 's'}</b></div>`,
  ].join('');
  renderMemory(ctx.memory);
  if (ctx.active && !runId) attach(ctx.active);
}

$('#presets').innerHTML = PRESETS.map(([label, text], i) => `<button type="button" class="chip" data-i="${i}">${esc(label)}</button>`).join('');
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (b) { $('#request').value = PRESETS[b.dataset.i][1]; $('#request').focus(); }
});
$('#request').value = PRESETS[0][1];
$('#request').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask').requestSubmit(); } });

$('#ask').addEventListener('submit', async (e) => {
  e.preventDefault();
  const request = $('#request').value.trim();
  if (!request) return;
  $('#go').disabled = true;
  const res = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request }) });
  const body = await res.json();
  if (!res.ok) { alert(body.error); if (body.id) attach(body.id); else $('#go').disabled = false; return; }
  attach(body.id);
});

$('#reset-btn').addEventListener('click', async () => {
  const forget = confirm('Reset the ERP and regenerate the inbox.\n\nAlso wipe the operator\'s learned memory? (OK = wipe, Cancel = keep)');
  const res = await fetch('/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ forgetMemory: forget }) });
  if (!res.ok) return alert((await res.json()).error);
  $('#stage').hidden = true;
  await loadContext();
});

function attach(id) {
  runId = id;
  shownAsks = '';
  $('#shot').hidden = true;
  state = freshState();
  source?.close();
  $('#stage').hidden = false;
  $('#go').disabled = true;
  renderAll();
  source = new EventSource(`/api/runs/${id}/events`);
  source.onmessage = (m) => { apply(JSON.parse(m.data)); schedule(); };
}

// ---------------------------------------------------------------- reducer
function feed(kind, label, text) { state.feed.push({ kind, label, text }); }

function apply(e) {
  switch (e.type) {
    case 'phase':
      state.phase = e.phase;
      state.counts[e.phase] = (state.counts[e.phase] || 0) + 1;
      state.phaseDetail = e.detail;
      if (['adapt', 'verify', 'complete'].includes(e.phase)) feed(e.phase, e.phase, e.detail);
      break;
    case 'goal': state.goal = e.goal; feed('observe', 'goal', e.goal.summary); break;
    case 'plan': state.tasks = e.tasks; break;
    case 'task.start': state.currentCase = e.caseId; feed('execute', 'act', `${e.title}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}`); break;
    case 'task.observe': if (e.observation) feed('observe', 'saw', e.observation); break;
    case 'task.error': feed('error', 'failed', e.error); break;
    case 'recovery': feed('recovery', 'recover', e.why); break;
    case 'memory': state.freshMemory = e.key; renderMemory(e.facts); feed('memory', 'learned', `${e.key} = ${e.value}`); break;
    case 'case': state.cases.set(e.case.id, { ...(state.cases.get(e.case.id) || {}), ...e.case }); break;
    case 'screen': state.shots.push(e); break;
    case 'human.request': state.asks.set(e.request.id, e.request); feed('human', 'asks you', e.request.title); break;
    case 'human.response': state.asks.delete(e.id); feed('human', 'answer', `${e.decision} — ${e.by}`); break;
    case 'verify': state.verify = e; break;
    case 'complete':
      state.result = e;
      feed('complete', 'done', e.summary);
      $('#go').disabled = false;
      loadContext();
      break;
  }
}

let pending = false;
function schedule() { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; renderAll(); }); } }

// ---------------------------------------------------------------- render
function renderAll() {
  renderPhases();
  renderGoal();
  renderCases();
  renderPlan();
  renderShots();
  renderAsks();
  renderResult();
  renderFeed();
}

function renderPhases() {
  $('#phases').innerHTML = PHASES.map((p) => `<li class="${state.counts[p] ? 'seen' : ''} ${state.phase === p ? 'now ' + p : ''}"><span class="dot"></span>${p[0].toUpperCase() + p.slice(1)}<span class="n">${state.counts[p] || ''}</span></li>`).join('');
  $('#phase-detail').textContent = state.phaseDetail || 'Waiting for a request…';
}

function renderGoal() {
  const g = state.goal;
  if (!g) { $('#goal').innerHTML = '<p class="empty">Interpreting the request…</p>'; return; }
  if (g.intent === 'unsupported') { $('#goal').innerHTML = `<p class="summary">${esc(g.summary)}</p><p class="empty">${esc(g.clarify)}</p>`; return; }
  $('#goal').innerHTML = `<p class="summary">${esc(g.summary)}</p>
<div class="acts"><span class="${g.actions.post ? 'yes' : 'no'}">post</span><span class="${g.actions.schedule ? 'yes' : 'no'}">schedule payment</span>${g.scope.vendors.length ? `<span class="yes">only ${esc(g.scope.vendors.join(', '))}</span>` : '<span>all suppliers</span>'}${g.reviewAbove != null ? `<span class="yes">review &gt; ${usd(g.reviewAbove)}</span>` : ''}</div>
<h3>Assumptions I made</h3><ul>${g.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
<h3>Constraints from policy</h3><ul>${g.constraints.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
<h3>Done means</h3><ul>${g.successCriteria.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`;
}

function renderCases() {
  const list = [...state.cases.values()];
  $('#case-count').textContent = list.length ? `${list.filter((c) => c.outcome).length}/${list.length} dispositioned` : '';
  $('#cases').innerHTML = list.length ? list.map((c) => {
    const tag = c.outcome ? `<span class="tag ${c.outcome}">${OUTCOME[c.outcome] || c.outcome}</span>` : `<span class="tag">${esc(c.status)}</span>`;
    const checks = (c.checks || []).map((k) => `<i class="${k.ok ? (k.severity === 'warn' ? 'warn' : '') : 'fail'}" title="${esc(k.name)}: ${esc(k.detail)}"></i>`).join('');
    return `<div class="case ${c.outcome || ''} ${state.currentCase === c.id && !state.result ? 'active' : ''}">
<div class="row1"><span class="sup">${esc(c.supplier || c.file)}</span><span class="amt">${usd(c.amount)}</span></div>
<div class="meta">${esc(c.number || c.file)}${c.po ? ' · ' + esc(c.po) : ''}</div>${tag}
${c.decision ? `<p class="why">${esc(c.decision.reason)}</p>` : c.outcomeNote ? `<p class="why">${esc(c.outcomeNote)}</p>` : ''}
${checks ? `<div class="checks">${checks}</div>` : ''}
${c.apRef ? `<div class="ref">${esc(c.apRef)}${c.payment ? ' · pays ' + esc(c.payment) : ''}${c.approval?.ref ? ' · ' + esc(c.approval.ref) : ''}${c.verification?.ok ? ' · read back ✓' : ''}</div>` : ''}
${c.draft ? `<div class="ref">✉ draft → ${esc(c.draft.to)}</div>` : ''}
</div>`;
  }).join('') : '<p class="empty">Nothing discovered yet.</p>';
}

function renderPlan() {
  const el = $('#plan');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  const RECOVERY = new Set(['erp.dismissDialog', 'wait']);
  el.innerHTML = state.tasks.map((t) => {
    const icon = { pending: '○', running: '◐', done: '✓', failed: '✗', skipped: '–', cancelled: '–' }[t.status];
    const rec = RECOVERY.has(t.kind) || /\bagain\b/.test(t.title);
    const cls = t.system === 'human' ? 'human' : t.risk === 'write' ? 'write' : '';
    return `<li class="${t.status} ${rec ? 'recovery' : ''} ${t.caseId ? 'indent' : ''}" ${t.status === 'running' ? 'data-running' : ''}><span class="st">${icon}</span><span class="title">${esc(t.title)}${t.attempts > 1 ? ` <small>×${t.attempts}</small>` : ''}</span><span class="tool ${cls}">${esc(t.tool)}</span></li>`;
  }).join('');
  const running = el.querySelector('[data-running]');
  if (running) {
    const top = running.offsetTop - el.offsetTop;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - 40) el.scrollTop = top - el.clientHeight / 2;
  }
  else if (atBottom) el.scrollTop = el.scrollHeight;
}

function renderShots() {
  const last = state.shots.at(-1);
  $('#shot-count').textContent = state.shots.length ? `${state.shots.length} screenshots` : '';
  if (last) {
    const src = `/runs/${runId}/${last.src}`;
    if ($('#shot').getAttribute('src') !== src) { $('#shot').src = src; $('#shot').hidden = false; }
    $('#shot-url').textContent = 'northwind-ledger' + (last.url || '/');
    $('#shot-label').textContent = last.note || last.label;
  }
  const film = state.shots.slice(-14).reverse();
  $('#film').innerHTML = film.map((s) => `<img src="/runs/${runId}/${s.src}" title="${esc(s.label)}" loading="lazy">`).join('');
}

let shownAsks = '';
function renderAsks() {
  const ids = [...state.asks.keys()].join();
  if (ids === shownAsks) return;
  shownAsks = ids;
  $('#asks').innerHTML = [...state.asks.values()].map((r) => `<div class="ask-card" data-id="${esc(r.id)}">
<div class="who">${r.kind === 'approval' ? `Approval needed · ${esc(r.approver)}${r.approverTitle ? ', ' + esc(r.approverTitle) : ''}` : 'I need a person'}</div>
<h3>${esc(r.title)}</h3><p>${esc(r.body || '')}</p>
${r.error ? `<p><code>${esc(r.error)}</code></p>` : ''}
${r.facts?.length ? `<table>${r.facts.map((f) => `<tr><td>${f.ok ? '✓' : '✗'} ${esc(f.label)}</td><td>${esc(f.value)}</td></tr>`).join('')}</table>` : ''}
<div class="btns">${r.options.map((o, i) => `<button data-v="${esc(o.value)}" class="${i === 0 ? 'primary' : ''}">${esc(o.label)}</button>`).join('')}</div></div>`).join('');
  if (ids) $('#asks').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('#asks').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  const card = b.closest('.ask-card');
  card.querySelectorAll('button').forEach((x) => (x.disabled = true));
  const r = state.asks.get(card.dataset.id);
  const by = r?.kind === 'approval' && r.approver !== 'You' ? `console user, for ${r.approver}` : 'You (console)';
  await fetch(`/api/runs/${runId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: card.dataset.id, decision: b.dataset.v, by }) });
});

function renderResult() {
  const r = state.result;
  if (!r) { $('#result').innerHTML = ''; return; }
  const v = state.verify;
  const issues = r.outcome !== 'completed';
  $('#result').innerHTML = `<div class="result ${issues ? 'issues' : ''}"><div class="kicker">${issues ? r.outcome.replace(/_/g, ' ') : 'Done · verified'}</div><h3>${esc(r.summary)}</h3>
${v ? `<table>${v.rows.map((x) => `<tr><td>${esc(x.invoice)}</td><td>${esc(x.expected)}</td><td>${esc(x.found)}</td><td class="${x.ok ? 'ok' : 'bad'}">${x.ok ? '✓ verified' : '✗'}</td></tr>`).join('')}</table>` : ''}
${r.report ? `<div class="links"><a href="/runs/${runId}/report.html" target="_blank" rel="noopener">Open evidence pack ↗</a><a class="alt" href="/runs/${runId}/journal.jsonl" target="_blank" rel="noopener">Raw journal</a><a class="alt" href="${esc(ctx?.erpUrl)}/invoices" target="_blank" rel="noopener">See it in the ERP ↗</a></div>` : ''}</div>`;
}

function renderFeed() {
  $('#feed').innerHTML = state.feed.slice(-120).reverse().map((f) => `<li class="${f.kind}"><b>${esc(f.label)}</b><span>${esc(f.text)}</span></li>`).join('');
}

function renderMemory(facts) {
  const entries = Object.entries(facts || {});
  $('#memory').innerHTML = entries.length ? entries.map(([k, v]) => `<div class="fact ${state?.freshMemory === k ? 'fresh' : ''}"><b>${esc(k)}</b> = ${esc(v.value)}<small>${esc(v.source)}</small></div>`).join('')
    : '<p class="empty">Nothing yet. Facts the operator discovers about company systems are kept here and reused next run.</p>';
}

// lightbox
document.addEventListener('click', (e) => {
  const img = e.target.closest('#shot, .film img');
  if (!img) return;
  const d = $('#lightbox');
  d.querySelector('img').src = img.src;
  d.showModal();
});

state = freshState();
loadContext();
