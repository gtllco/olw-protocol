// ── pull.js — 555 semantic capability pull ──────────────────────────────────
// Capability finds capability by INTENT. Hard-gate on the 8-axis fingerprint,
// then rank survivors by semantic similarity of what they actually do.
// Embeddings are sovereign: local nomic-embed-text on ollama. $0, never leaves box.
//
// Soul Guide's hinge (the line between alive and "just search"):
//   the "why" must be a reasoned routing decision in the axis vocabulary,
//   NOT a bare similarity score.

const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = process.env.OLW_EMBED_MODEL || 'nomic-embed-text';

// Embed text → vector via local ollama. Throws on failure (caller decides grace).
export async function embed(text) {
  const r = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!r.ok) throw new Error(`embed failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  if (!Array.isArray(j.embedding)) throw new Error('embed: no vector returned');
  return j.embedding;
}

// The canonical "what this agent does" string we embed — fingerprint as language.
export function capabilityText(a) {
  const fp = a.fingerprint || {};
  const res = a.resonance;
  return [
    a.name,
    a.description,
    fp.domain && `domain: ${fp.domain}`,
    fp.task_types?.length && `tasks: ${fp.task_types.join(', ')}`,
    fp.input_formats?.length && `accepts: ${fp.input_formats.join(', ')}`,
    fp.output_formats?.length && `produces: ${fp.output_formats.join(', ')}`,
    fp.context_depth && `${fp.context_depth} context`,
    fp.latency_class && `${fp.latency_class} latency`,
    fp.trust_level && `${fp.trust_level} trust`,
    res?.signal && `coherence: ${res.signal}${res.bpm ? ` ${res.bpm}bpm` : ''}`,
  ].filter(Boolean).join('. ');
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Hard gates: structured fingerprint filter. Eliminate structurally-wrong
// candidates before similarity runs (so we never rank noise).
export function matchConstraints(fp = {}, c = {}) {
  for (const [k, v] of Object.entries(c || {})) {
    const av = fp[k];
    if (av === undefined) return false;
    if (Array.isArray(av)) { if (!av.includes(v)) return false; }
    else if (typeof av === 'boolean') { if (av !== (v === true || v === 'true')) return false; }
    else if (String(av) !== String(v)) return false;
  }
  return true;
}

const URGENCY = /\b(fast|quick|instant|real[- ]?time|realtime|now|urgent|low[- ]?latency|immediately|asap)\b/;

// Reasoned routing decision in the axis vocabulary — the soul of the pull.
// Explains WHY this agent, for THIS intent — not just how confident we are.
export function buildWhy(intent, agent, constraints) {
  const fp = agent.fingerprint || {};
  const lc = (intent || '').toLowerCase();
  const out = [];

  if (fp.domain) out.push(`domain:${fp.domain}`);

  // surface the specific tasks whose meaning shows up in the intent
  const hit = (fp.task_types || []).filter(t =>
    lc.includes(t.replace(/_/g, ' ')) ||
    t.split('_').some(w => w.length > 3 && lc.includes(w)));
  if (hit.length) out.push(`task↦${hit.join('/')}`);
  else if ((fp.task_types || []).length) out.push(`tasks:${fp.task_types.slice(0, 2).join('/')}`);

  // latency only surfaces as a reason when the intent actually signals urgency
  if (URGENCY.test(lc) && fp.latency_class) out.push(`latency:${fp.latency_class}`);

  out.push(`${fp.trust_level || 'open'} trust`);

  const res = agent.resonance;
  if (res?.signal) out.push(`resonance:${res.signal}${res.bpm ? `@${res.bpm}bpm` : ''}`);

  const sat = Object.entries(constraints || {})
    .filter(([k, v]) => String(fp[k]) === String(v) || (Array.isArray(fp[k]) && fp[k].includes(v)))
    .map(([k, v]) => `${k}=${v}`);
  if (sat.length) out.push(`gates✓ ${sat.join(',')}`);

  return out.join(' · ');
}

// The pull. agents: array of stored docs (with ._vec). Returns ranked matches.
// constraints can include fingerprint fields AND resonance.signal (777|555|333)
export async function pull(agents, intent, constraints = {}, k = 5) {
  const { signal, ...fpConstraints } = constraints;
  const gated = agents.filter(a => {
    if (!matchConstraints(a.fingerprint, fpConstraints)) return false;
    if (signal && a.resonance?.signal !== signal) return false;
    return true;
  });
  const qv = await embed(intent);
  const scored = [];
  for (const a of gated) {
    if (!Array.isArray(a._vec)) continue;          // skip un-embedded agents
    scored.push({ a, score: cosine(qv, a._vec) });
  }
  scored.sort((x, y) => y.score - x.score);
  return {
    gated: gated.length,
    ranked: scored.length,
    matches: scored.slice(0, k).map(({ a, score }) => ({
      address: a.address,
      name: a.name,
      endpoint: a.endpoint,
      score: Math.round(score * 1000) / 1000,
      why: buildWhy(intent, a, constraints),   // reasoned, not a bare number
    })),
  };
}
