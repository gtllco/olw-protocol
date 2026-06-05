// Backfill embedding vectors for every agent missing one. In-place, preserves
// all existing fields (verified flag, timestamps, etc). Idempotent.
import { readFileSync, writeFileSync } from 'fs';
import { embed, capabilityText } from './pull.js';

const DB = '/opt/olw/index-server/agents.json';
const db = JSON.parse(readFileSync(DB, 'utf8'));
let done = 0, skip = 0, fail = 0;

for (const [addr, a] of Object.entries(db.agents)) {
  if (Array.isArray(a._vec) && a._vec.length) { skip++; continue; }
  try { a._vec = await embed(capabilityText(a)); done++; console.log(`embedded ${addr} (${a._vec.length}d)`); }
  catch (e) { fail++; console.error(`FAIL ${addr}: ${e.message}`); }
}
writeFileSync(DB, JSON.stringify(db, null, 2));
console.log(`\nreindex: ${done} embedded, ${skip} already had vectors, ${fail} failed`);
