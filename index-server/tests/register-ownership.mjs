#!/usr/bin/env node
// Ownership-verified registration tests (Phase 2 · task 2-01 + 2-02).
// Requires the test-mismatch.json fixture served at 777.gtll.app/.well-known/olw/.
import crypto from 'crypto';

const BASE = 'http://localhost:3778';
const WK_GOOD = 'https://777.gtll.app/.well-known/olw/agent.json';
const WK_MISMATCH = 'https://777.gtll.app/.well-known/olw/test-mismatch.json';

let pass = 0, fail = 0;
const ok  = (m) => { console.log(`  \x1b[32m✓\x1b[0m ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); fail++; };
const post = (body) => fetch(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const run = async () => {
  console.log('\n\x1b[1mOLW Register — Ownership Verification\x1b[0m\n');

  // §1 verified happy path
  console.log('§1 verified path');
  let r = await post({ well_known_url: WK_GOOD });
  let b = await r.json();
  r.status === 200 && b.verified === true ? ok('valid .well-known → 200 verified:true') : bad(`got ${r.status} verified=${b.verified}`);
  b.address === 'soul-guide@gtll.olw' ? ok('address taken from agent.json') : bad(`address=${b.address}`);

  // §2 ownership binding enforced
  console.log('\n§2 binding rule');
  r = await post({ well_known_url: WK_MISMATCH });
  b = await r.json();
  r.status === 403 && /ownership not proven/.test(b.error) ? ok('valid file, wrong owner-domain → 403') : bad(`got ${r.status}: ${b.error}`);

  r = await post({ well_known_url: 'https://example.com/.well-known/olw/agent.json' });
  [404, 502].includes(r.status) ? ok('missing file → 404/502') : bad(`got ${r.status}`);

  r = await post({ well_known_url: 'http://777.gtll.app/.well-known/olw/agent.json' });
  b = await r.json();
  r.status === 502 || /https/.test(b.error || '') ? ok('non-https well_known_url rejected') : bad(`got ${r.status}: ${b.error}`);

  // §3 address mismatch guard
  console.log('\n§3 explicit address mismatch');
  r = await post({ well_known_url: WK_GOOD, address: 'someone-else@gtll.olw' });
  b = await r.json();
  r.status === 409 ? ok('requested address ≠ agent.json address → 409') : bad(`got ${r.status}: ${b.error}`);

  // §4 legacy inline still works, marked unverified
  console.log('\n§4 legacy inline path');
  const tmpAddr = `tmp-${crypto.randomBytes(3).toString('hex')}@regtest.olw`;
  r = await post({ address: tmpAddr, fingerprint: { domain: 'test' }, endpoint: 'https://x.dev' });
  b = await r.json();
  r.status === 200 && b.verified === false ? ok('inline body → 200 verified:false') : bad(`got ${r.status} verified=${b.verified}`);
  r = await post({ name: 'no address' });
  r.status === 400 ? ok('inline missing address/fingerprint → 400') : bad(`got ${r.status}`);

  console.log(`\n\x1b[1mResult: ${pass} passed, ${fail} failed\x1b[0m\n`);
  // cleanup the temp legacy agent
  try {
    const fs = await import('fs');
    const db = JSON.parse(fs.readFileSync('agents.json', 'utf8'));
    if (db.agents[tmpAddr]) { delete db.agents[tmpAddr]; fs.writeFileSync('agents.json', JSON.stringify(db, null, 2)); }
  } catch {}
  process.exit(fail === 0 ? 0 : 1);
};
run().catch(e => { console.error('FATAL', e); process.exit(1); });
