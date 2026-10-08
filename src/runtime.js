// Wiring shared by the console, the CLI demo and the tests: start the company world (ERP +
// inbox) and launch operator runs against it.
import fs from 'node:fs';
import path from 'node:path';
import { startErp } from './world/erp-server.js';
import { makeInbox } from './world/inbox.js';
import { loadContext, Memory, ROOT } from './operator/context.js';
import { Run } from './operator/run.js';
import { Operator } from './operator/agent.js';

export async function startWorld({ port = Number(process.env.ERP_PORT || 4100), erpOptions } = {}) {
  const erp = await startErp(port, erpOptions);
  process.env.ERP_URL = erp.url;
  const ctx = loadContext();
  if (!fs.existsSync(ctx.inboxDir) || !fs.readdirSync(ctx.inboxDir).length) await makeInbox(ctx.inboxDir);
  return {
    erp,
    async reset({ forgetMemory = false } = {}) {
      erp.reset();
      await makeInbox(ctx.inboxDir);
      fs.rmSync(ctx.outboxDir, { recursive: true, force: true });
      if (forgetMemory) new Memory().clear();
    },
  };
}

export function launchRun(request, { root = path.join(ROOT, 'runs'), pace = 0 } = {}) {
  const ctx = loadContext();
  const memory = new Memory();
  const run = new Run({ request, root });
  const op = new Operator({ run, ctx, memory, pace });
  run.done = op.execute();
  return run;
}
