import { makeInbox } from '../src/world/inbox.js';
const files = await makeInbox(process.argv[2] || 'var/inbox');
console.log(`Wrote ${files.length} invoices:\n  ${files.join('\n  ')}`);
