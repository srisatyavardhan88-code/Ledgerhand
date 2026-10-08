// A Run is the operator's working state for one request: the event journal (append-only,
// replayable), the evidence folder, and the open human-in-the-loop requests.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

let counter = 0;

export class Run extends EventEmitter {
  constructor({ request, root = 'runs' }) {
    super();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    this.id = `run-${stamp}-${++counter}`;
    this.request = request;
    this.dir = path.resolve(root, this.id);
    fs.mkdirSync(path.join(this.dir, 'shots'), { recursive: true });
    this.events = [];
    this.pending = new Map(); // id -> { request, resolve }
    this.status = 'running';
    this.shotSeq = 0;
  }

  emitEvent(type, data = {}) {
    const evt = { seq: this.events.length, at: new Date().toISOString(), type, ...data };
    this.events.push(evt);
    fs.appendFileSync(path.join(this.dir, 'journal.jsonl'), JSON.stringify(evt) + '\n');
    this.emit('event', evt);
    return evt;
  }

  // Pause the loop until a human answers. `request.options` lists the allowed answers.
  ask(request) {
    const id = `${request.kind}-${this.pending.size + 1}-${Date.now().toString(36)}`;
    const full = { id, ...request };
    this.emitEvent('human.request', { request: full });
    return new Promise((resolve) => this.pending.set(id, { request: full, resolve }));
  }

  answer(id, decision, by = 'console') {
    const p = this.pending.get(id);
    if (!p) return false;
    if (!p.request.options.some((o) => o.value === decision)) return false;
    this.pending.delete(id);
    this.emitEvent('human.response', { id, decision, by });
    p.resolve({ decision, by });
    return true;
  }

  shotPath(label) {
    const name = `${String(++this.shotSeq).padStart(3, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.jpg`;
    return { file: path.join(this.dir, 'shots', name), rel: `shots/${name}` };
  }
}
