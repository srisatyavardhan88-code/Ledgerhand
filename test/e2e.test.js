// End to end: real ERP server, real PDFs, real Chromium. Approvals are answered by the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { startWorld, launchRun } from '../src/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerhand-'));
let world;

test.before(async () => { world = await startWorld({ port: 0 }); });
test.after(() => world.erp.server.close());

async function runWith(request, answer = () => 'approve') {
  const run = launchRun(request, { root });
  run.on('event', (e) => { if (e.type === 'human.request') setTimeout(() => run.answer(e.request.id, answer(e.request), 'test'), 10); });
  await run.done;
  const erp = world.erp.state();
  const byNumber = Object.fromEntries(erp.invoices.map((i) => [i.number, i]));
  const kinds = (t) => run.events.filter((e) => e.type === t);
  return { run, erp, byNumber, kinds };
}

test('clears the inbox: posts, schedules, holds, blocks fraud, skips duplicate, verifies', { timeout: 180000 }, async () => {
  await world.reset({ forgetMemory: true });
  const { run, erp, byNumber, kinds } = await runWith("Clear this week's supplier invoices and get what checks out into Friday's payment run.");
  assert.equal(run.status, 'completed');
  assert.equal(erp.invoices.length, 4, 'one ERP record per genuine invoice, none for fraud or duplicate');
  assert.equal(byNumber['INV-88412'].status, 'Scheduled');
  assert.equal(byNumber['GFL-2026-0931'].match, 'Within tolerance');
  assert.equal(byNumber['IH-7731'].status, 'Scheduled');
  assert.match(byNumber['IH-7731'].approval, /^APR-\d+/);
  assert.equal(byNumber['UFS-10442'].status, 'On hold');
  assert.equal(byNumber['HC-00912'], undefined);
  const strategies = kinds('recovery').map((r) => r.strategy);
  for (const s of ['dismiss_dialog', 'adapt_input', 'reauthenticate']) assert.ok(strategies.includes(s), `expected a ${s} recovery, got ${strategies}`);
  assert.equal(kinds('verify')[0].allOk, true);
  assert.ok(fs.existsSync(path.join(run.dir, 'report.html')));
  assert.equal(fs.readdirSync(path.join(run.dir, 'outbox')).length, 2);
});

test('second run reuses what it learned (no date-format failure)', { timeout: 180000 }, async () => {
  await world.reset();
  const { run, kinds } = await runWith('Post the supplier invoices but do not schedule payments.');
  assert.equal(run.status, 'completed');
  assert.ok(!kinds('recovery').some((r) => r.strategy === 'adapt_input'));
  assert.ok(world.erp.state().invoices.every((i) => i.status !== 'Scheduled'));
});

test('a rejected approval changes the plan: the invoice is held, not posted', { timeout: 180000 }, async () => {
  await world.reset();
  const { byNumber, run } = await runWith('Clear the AP inbox and pay what checks out.', (r) => (r.kind === 'approval' ? 'reject' : r.options.at(-1).value));
  assert.equal(run.status, 'completed');
  assert.equal(byNumber['IH-7731'].status, 'On hold');
});

test('dry run changes nothing in the ERP', { timeout: 180000 }, async () => {
  await world.reset();
  const { erp, run } = await runWith("Just check the AP inbox against the ERP. Don't post anything.");
  assert.equal(run.status, 'completed');
  assert.equal(erp.invoices.length, 0);
});
