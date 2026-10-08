// Operator console: start runs, watch the loop live (SSE), answer approvals, open evidence.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { startWorld, launchRun } from '../runtime.js';
import { loadContext, Memory, ROOT } from '../operator/context.js';
import { llmEnabled } from '../operator/llm.js';

const PORT = Number(process.env.PORT || 4000);
const PACE = Number(process.env.PACE_MS ?? 220);

const world = await startWorld();
const runs = new Map();
let active = null;

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'src/console/public')));
app.use('/runs', express.static(path.join(ROOT, 'runs')));

app.get('/api/context', (req, res) => {
  const ctx = loadContext();
  res.json({
    company: ctx.policy.company, policy: ctx.policy, sop: ctx.sop, people: ctx.directory.people,
    erpUrl: world.erp.url, memory: new Memory().all(), llm: llmEnabled(),
    inbox: fs.existsSync(ctx.inboxDir) ? fs.readdirSync(ctx.inboxDir).filter((f) => f.endsWith('.pdf')).sort() : [],
    active: active && active.status === 'running' ? active.id : null,
    runs: [...runs.values()].map((r) => ({ id: r.id, request: r.request, status: r.status })).reverse(),
  });
});

app.post('/api/runs', (req, res) => {
  const request = String(req.body.request || '').trim();
  if (!request) return res.status(400).json({ error: 'Tell the operator what you need.' });
  if (active && active.status === 'running') return res.status(409).json({ error: 'A run is already in progress.', id: active.id });
  const run = launchRun(request, { pace: PACE });
  runs.set(run.id, run);
  active = run;
  res.json({ id: run.id });
});

app.get('/api/runs/:id/events', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).end();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  run.events.forEach(send);
  run.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { run.off('event', send); clearInterval(ping); });
});

app.post('/api/runs/:id/answer', (req, res) => {
  const run = runs.get(req.params.id);
  const ok = run?.answer(req.body.requestId, req.body.decision, req.body.by || 'console user');
  res.status(ok ? 200 : 400).json({ ok: Boolean(ok) });
});

app.post('/api/reset', async (req, res) => {
  if (active && active.status === 'running') return res.status(409).json({ error: 'Wait for the current run to finish.' });
  await world.reset({ forgetMemory: Boolean(req.body?.forgetMemory) });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Ledgerhand console  http://localhost:${PORT}`);
  console.log(`Northwind Ledger ERP ${world.erp.url}  (user lena.hart / northwind-demo)`);
  console.log(llmEnabled() ? 'Claude: on (ANTHROPIC_API_KEY set)' : 'Claude: off — using the built-in interpreter');
});
