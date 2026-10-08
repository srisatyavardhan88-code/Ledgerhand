// Headless demo: start the world, run one request end to end, answer approvals from flags,
// and narrate the loop in the terminal.
//   node scripts/demo.js "Clear this week's supplier invoices and schedule what checks out" --approve
import { startWorld, launchRun } from '../src/runtime.js';

const args = process.argv.slice(2);
const request = args.find((a) => !a.startsWith('--')) || "Clear this week's supplier invoices from the AP inbox and get everything that checks out into Friday's payment run.";
const approve = !args.includes('--reject');
const fresh = args.includes('--fresh');

const world = await startWorld({ port: 0 });
await world.reset({ forgetMemory: fresh });
const run = launchRun(request);
const C = { phase: '\x1b[35m', ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' };
run.on('event', (e) => {
  switch (e.type) {
    case 'phase': return console.log(`${C.phase}▌${e.phase.toUpperCase()}${C.off} ${e.detail || ''}`);
    case 'goal': return console.log(`  goal: ${e.goal.summary}\n  ${C.dim}${e.goal.assumptions.join(' ')}${C.off}`);
    case 'task.start': return console.log(`  ${C.dim}→ [${e.tool}] ${e.title}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}${C.off}`);
    case 'task.error': return console.log(`  ${C.bad}✗ ${e.kind}: ${e.error}${C.off}`);
    case 'recovery': return console.log(`  ${C.warn}↻ ${e.strategy}: ${e.why}${C.off}`);
    case 'memory': return console.log(`  ${C.warn}✎ learned ${e.key} = ${e.value}${C.off}`);
    case 'human.request': {
      const r = e.request;
      console.log(`  ${C.warn}✋ ${r.title}${C.off} ${r.body || ''}`);
      const pick = r.kind === 'approval' ? (approve ? 'approve' : 'reject') : r.options.at(-1).value;
      setTimeout(() => run.answer(r.id, pick, r.approver ? `${r.approver} (demo auto-answer)` : 'demo auto-answer'), 300);
      return;
    }
    case 'verify': return e.rows.forEach((r) => console.log(`  ${r.ok ? C.ok + '✓' : C.bad + '✗'} ${r.invoice}: expected ${r.expected}, ERP has ${r.found}${C.off}`));
    case 'complete': return console.log(`\n${C.ok}■ ${e.outcome}${C.off} ${e.summary}\n  evidence: ${run.dir}/report.html`);
  }
});
await run.done;
world.erp.server.close();
process.exit(run.status === 'completed' ? 0 : 1);
