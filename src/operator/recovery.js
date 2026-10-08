// Failure taxonomy and recovery strategies. The loop never retries blindly: each failure is
// classified from what was observed, and the strategy says what to do differently next time.

export class OperatorError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}
export const SessionExpired = (msg = 'ERP redirected to the sign-in page: session expired') => new OperatorError('session_expired', msg);
export const BlockedByOverlay = (msg) => new OperatorError('blocked_by_overlay', msg);
export const ValidationError = (msg, shot) => new OperatorError('validation', msg, { shot });
export const NotFound = (msg) => new OperatorError('not_found', msg);

export function classify(err) {
  if (err instanceof OperatorError) return err.kind;
  const m = String(err?.message || err);
  if (/intercepts pointer events|element is not visible|is not stable/i.test(m)) return 'blocked_by_overlay';
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|net::ERR|Timeout \d+ms exceeded|Navigation timeout/i.test(m)) return 'transient';
  return 'unknown';
}

// Returns { strategy, why, before: [tasks to run first], learn?: [key, value], retry: bool }
export function planRecovery(err, task, memory) {
  const kind = classify(err);
  const msg = String(err.message || err);
  switch (kind) {
    case 'session_expired':
      return { strategy: 'reauthenticate', why: 'The ERP signed the operator out. Sign in again with the service account from the vault, then repeat the step.', before: [{ kind: 'erp.login', title: 'Sign in again (session expired)' }], retry: true };
    case 'blocked_by_overlay':
      return { strategy: 'dismiss_dialog', why: 'A dialog is covering the page and swallowing clicks. Read it, acknowledge it, then repeat the click.', before: [{ kind: 'erp.dismissDialog', title: 'Read and dismiss the blocking dialog' }], retry: true };
    case 'transient':
      return { strategy: 'backoff', why: `Looks transient (${msg.slice(0, 80)}). Wait and retry.`, before: [{ kind: 'wait', title: `Back off ${task.attempts * 1.5}s`, args: { ms: task.attempts * 1500 } }], retry: true };
    case 'validation': {
      const fmt = /must be in ([DMY/.-]+) format/i.exec(msg)?.[1];
      if (fmt && memory.get('erp.dateFormat') !== fmt) {
        return { strategy: 'adapt_input', why: `The ERP rejected the date format and told us what it wants (${fmt}). Remember that for next time and re-enter the dates.`, before: [], learn: ['erp.dateFormat', fmt], retry: true };
      }
      const dup = /Duplicate invoice: (.+) is already recorded as (AP-\d+)/i.exec(msg);
      if (dup) return { strategy: 'adopt_existing', why: `The ERP already holds this invoice as ${dup[2]}. Check whether that record is ours from an earlier attempt instead of entering it twice.`, before: [], adopt: dup[2], retry: false };
      return { strategy: 'ask_human', why: `The ERP rejected the entry: “${msg}”. This needs a person.`, before: [], retry: false };
    }
    case 'not_found':
      return { strategy: 'ask_human', why: msg, before: [], retry: false };
    default:
      return task.attempts < 2
        ? { strategy: 'retry', why: `Unexpected error (${msg.slice(0, 100)}). Try once more after reloading.`, before: [{ kind: 'wait', title: 'Pause and reload', args: { ms: 800 } }], retry: true }
        : { strategy: 'ask_human', why: `Still failing after ${task.attempts} attempts: ${msg.slice(0, 160)}`, before: [], retry: false };
  }
}
