// Company context the operator reasons with: policy-as-data, the written procedure, the
// people directory, the credential vault, and what it has learned on earlier runs.
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

export function loadContext() {
  const directory = readJson('company/directory.json');
  return {
    policy: readJson('company/policy.json'),
    directory,
    sop: fs.readFileSync(path.join(ROOT, 'company/handbook/ap-procedure.md'), 'utf8'),
    vault: readJson('company/vault.json'),
    inboxDir: path.join(ROOT, directory.systems.inbox.path),
    outboxDir: path.join(ROOT, directory.systems.outbox.path),
    erpUrl: process.env.ERP_URL || directory.systems.erp.url,
    person: (id) => directory.people.find((p) => p.id === id),
    byRole: (role) => directory.people.find((p) => p.role === role),
  };
}

// Long-term memory: facts the operator learned about the company's systems, with provenance.
export class Memory {
  constructor(file = path.join(ROOT, 'var/memory.json')) {
    this.file = file;
    try { this.facts = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.facts = {}; }
  }
  get(key) { return this.facts[key]?.value; }
  set(key, value, source) {
    this.facts[key] = { value, source, learnedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.facts, null, 2));
  }
  all() { return this.facts; }
  clear() { this.facts = {}; fs.rmSync(this.file, { force: true }); }
}
