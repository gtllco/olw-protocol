// ── crawl.mjs — Googlebot for the agent web ─────────────────────────────────
// Sweeps a public agent surface (HuggingFace Spaces), auto-fingerprints each
// into the 8-axis schema, and registers it as a DISCOVERED, UNVERIFIED node.
// This is the Google model: index what's publicly there; verification/claim is
// a separate (monetizable) step. Honest labeling: source + discovered:true.
//
// Usage: node crawl.mjs [query] [limit]

const BASE = process.env.OLW_BASE || 'http://localhost:3778';
const QUERY = process.argv[2] || 'agent';
const LIMIT = Math.min(parseInt(process.argv[3], 10) || 30, 100);

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'agent';

// crude domain inference from text — rough on purpose; a discovered node is a
// candidate, not a verified claim. Owner can refine on claim.
const DOMAIN_HINTS = [
  [/legal|contract|law|compliance/, 'legal'],
  [/financ|invoic|account|trading|stock|tax/, 'finance'],
  [/health|medic|clinic|patient|diagnos/, 'health'],
  [/sales|crm|lead|deal|outreach/, 'sales'],
  [/translat|languag|multilingual/, 'language'],
  [/image|vision|photo|diffusion|art|draw/, 'vision'],
  [/voice|speech|audio|transcri|whisper/, 'audio'],
  [/code|program|developer|github|sql/, 'code'],
  [/research|search|retriev|rag|knowledge/, 'research'],
  [/travel|trip|book|hotel|flight/, 'travel'],
  [/writ|content|copy|blog|essay/, 'writing'],
  [/data|analy|chart|dashboard/, 'data'],
];
function inferDomain(text) {
  const t = (text || '').toLowerCase();
  for (const [re, d] of DOMAIN_HINTS) if (re.test(t)) return d;
  return 'general';
}

async function fetchSpaces() {
  const url = `https://huggingface.co/api/spaces?search=${encodeURIComponent(QUERY)}&limit=${LIMIT}&full=true`;
  const r = await fetch(url, { headers: { 'User-Agent': 'OLW-Crawler/0.1 (+https://olw.gtll.app)' } });
  if (!r.ok) throw new Error(`HF api ${r.status}`);
  return r.json();
}

function toAgent(sp) {
  const card = sp.cardData || {};
  const title = card.title || sp.id.split('/').pop();
  const desc = (card.short_description || card.title || `${title} — an agent discovered on HuggingFace Spaces.`).toString().slice(0, 300);
  const tags = (sp.tags || []).filter(Boolean);
  const blob = `${title} ${desc} ${tags.join(' ')} ${(card.models || []).join(' ')}`;
  const domain = inferDomain(blob);
  const tasks = tags.filter(t => /agent|chat|tool|generat|summar|classif|search|translat|code|image|audio/i.test(t)).slice(0, 4);
  return {
    address: `${slug(sp.id.replace('/', '-'))}@huggingface.olw`,
    name: title,
    description: desc,
    endpoint: `https://huggingface.co/spaces/${sp.id}`,
    fingerprint: {
      domain,
      task_types: tasks.length ? tasks.map(t => t.toLowerCase()) : ['conversation'],
      input_formats: ['text'],
      output_formats: ['text'],
      context_depth: 'shallow',
      latency_class: 'standard',
      trust_level: 'open',
      soul_compatible: false,
    },
    source: 'crawl:huggingface',
    discovered: true,
    discovered_at: new Date().toISOString(),
    popularity: sp.likes || 0,
  };
}

const spaces = await fetchSpaces();
console.log(`fetched ${spaces.length} spaces for "${QUERY}"`);
let ok = 0, err = 0;
for (const sp of spaces) {
  const a = toAgent(sp);
  try {
    const r = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) });
    const j = await r.json();
    if (r.ok && j.registered) { ok++; console.log(`  ✓ ${a.address}  [${a.fingerprint.domain}]`); }
    else { err++; console.error(`  ✗ ${a.address}: ${JSON.stringify(j).slice(0, 80)}`); }
  } catch (e) { err++; console.error(`  ✗ ${a.address}: ${e.message}`); }
}
console.log(`\ncrawl: ${ok} discovered nodes added, ${err} failed`);
