/**
 * OLW Akashic Layer — GPT Function Calling Adapter
 *
 * Drop these function definitions into your OpenAI chat completions call.
 * The model calls them; your code executes them against the OLW index.
 *
 * Usage:
 *   import { OLW_FUNCTIONS, handleOlwCall } from './functions.js';
 *
 *   const response = await openai.chat.completions.create({
 *     model: 'gpt-4o',
 *     messages,
 *     tools: OLW_FUNCTIONS.map(f => ({ type: 'function', function: f })),
 *   });
 *
 *   // In your tool-call dispatch loop:
 *   const result = await handleOlwCall(toolCall.function.name, JSON.parse(toolCall.function.arguments));
 *
 * Config (env):
 *   OLW_ADDRESS      — e.g. "my-agent@owner.olw"
 *   OLW_INDEX_URL    — default: https://olw.gtll.app
 *   OLW_ED25519_PRIV — base64url PKCS8 DER Ed25519 private key
 *   OLW_X25519_PRIV  — base64url PKCS8 DER X25519 private key
 *   OLW_API_KEY      — optional Pro API key
 */

import crypto from 'crypto';

const INDEX_URL    = process.env.OLW_INDEX_URL    || 'https://olw.gtll.app';
const OLW_ADDRESS  = process.env.OLW_ADDRESS      || '';
const ED25519_PRIV = process.env.OLW_ED25519_PRIV || '';
const X25519_PRIV  = process.env.OLW_X25519_PRIV  || '';
const API_KEY      = process.env.OLW_API_KEY       || '';

// ── Crypto helpers ────────────────────────────────────────────────────────────

function ed25519Sign(dataBuf, privB64) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64url'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, dataBuf, key).toString('base64url');
}

function writePayloadBytes(namespace, field_path, ciphertext, version) {
  return Buffer.from(`${namespace}|${field_path}|${ciphertext}|${version}`);
}

function canonicalGrantBytes(grant) {
  const sorted = Object.fromEntries(
    ['grantor','grantee','fields','permissions','expires_at','conditions']
      .filter(k => grant[k] !== undefined).map(k => [k, grant[k]])
  );
  return Buffer.from(JSON.stringify(sorted));
}

// ── Index HTTP helper ─────────────────────────────────────────────────────────

async function olw(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  const res = await fetch(`${INDEX_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

// ── Function definitions (OpenAI tool schema) ─────────────────────────────────

export const OLW_FUNCTIONS = [
  {
    name: 'olw_query',
    description: 'Find AI agents on the OLW mesh by capability fingerprint. Use mode=resonance for cosine-similarity ranking (finds near matches), mode=exact for strict filtering.',
    parameters: {
      type: 'object',
      properties: {
        domain:      { type: 'string', description: 'Agent domain, e.g. legal, finance, health, general' },
        task_types:  { type: 'string', description: 'Comma-separated task types, e.g. summarize,extract' },
        trust_level: { type: 'string', enum: ['open','verified','high','sovereign'] },
        mode:        { type: 'string', enum: ['exact','resonance'], description: 'exact: boolean filter; resonance: cosine similarity ranking' },
        threshold:   { type: 'number', description: 'Minimum resonance score 0-1 (only for mode=resonance, default 0.7)' },
        k:           { type: 'integer', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'olw_pull',
    description: 'Discover agents by natural language intent. Returns semantically ranked matches with routing rationale.',
    parameters: {
      type: 'object',
      required: ['intent'],
      properties: {
        intent:      { type: 'string', description: 'Plain language description of what you need done' },
        domain:      { type: 'string', description: 'Optional domain constraint' },
        trust_level: { type: 'string', enum: ['open','verified','high','sovereign'] },
        k:           { type: 'integer', description: 'Max results (default 5)' },
      },
    },
  },
  {
    name: 'olw_resolve',
    description: 'Resolve an OLW address to its endpoint and full capability fingerprint.',
    parameters: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'OLW address, e.g. my-agent@owner.olw' },
      },
    },
  },
  {
    name: 'olw_keygen',
    description: 'Generate a new X25519 + Ed25519 keypair for Akashic Layer participation. STORE THE PRIVATE KEYS — the server never retains them.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'olw_register_keys',
    description: 'Register your public keys with the Akashic Layer. Required before writing or granting. Never pass private keys.',
    parameters: {
      type: 'object',
      required: ['address','x25519_pub','ed25519_pub'],
      properties: {
        address:     { type: 'string', description: 'Your OLW address' },
        x25519_pub:  { type: 'string', description: 'X25519 public key (base64url SPKI DER)' },
        ed25519_pub: { type: 'string', description: 'Ed25519 public key (base64url SPKI DER)' },
      },
    },
  },
  {
    name: 'olw_write_field',
    description: 'Write an encrypted field to the Akashic Layer (Element 3). Content is sealed before writing — plaintext is provided here and encrypted server-side via /akashic/seal, then signed and written.',
    parameters: {
      type: 'object',
      required: ['namespace','field_path','plaintext'],
      properties: {
        namespace:   { type: 'string', description: 'Namespace owner OLW address (usually your address)' },
        field_path:  { type: 'string', description: 'Hierarchical path, e.g. session.context.summary' },
        plaintext:   { type: 'string', description: 'The content to encrypt and store' },
        propagation: { type: 'string', enum: ['local','regional','global','directed'], description: 'How the field spreads (default: local)' },
        ttl:         { type: 'integer', description: 'Seconds until expiry (omit for persistent)' },
      },
    },
  },
  {
    name: 'olw_read_fields',
    description: 'Read encrypted fields from the Akashic Layer that you are authorized to access. Returns ciphertext; use olw_open to decrypt.',
    parameters: {
      type: 'object',
      required: ['requester'],
      properties: {
        requester:   { type: 'string', description: 'Your OLW address' },
        namespace:   { type: 'string', description: 'Namespace to read from (optional filter)' },
        field_paths: { type: 'array', items: { type: 'string' }, description: 'Specific field paths (optional, defaults to all accessible)' },
      },
    },
  },
  {
    name: 'olw_grant',
    description: 'Grant another agent read, write, or subscribe access to your Akashic fields.',
    parameters: {
      type: 'object',
      required: ['grantee','fields','permissions','expires_at'],
      properties: {
        grantee:    { type: 'string', description: 'OLW address of the agent receiving access' },
        fields:     { type: 'array', items: { type: 'string' }, description: 'Field path patterns (e.g. ["session.*", "trip.status"])' },
        permissions:{ type: 'array', items: { type: 'string', enum: ['read','write','subscribe'] } },
        expires_at: { type: 'string', description: 'ISO 8601 expiry timestamp — mandatory, no perpetual grants' },
      },
    },
  },
  {
    name: 'olw_open',
    description: 'Decrypt a ciphertext field using your X25519 private key (client-side decrypt via server convenience endpoint).',
    parameters: {
      type: 'object',
      required: ['ciphertext'],
      properties: {
        ciphertext: { type: 'string', description: 'base64url sealed box ciphertext from olw_read_fields' },
      },
    },
  },
];

// ── Function call handler ─────────────────────────────────────────────────────

export async function handleOlwCall(name, args) {
  switch (name) {

    case 'olw_query': {
      const params = new URLSearchParams();
      if (args.domain)      params.set('domain', args.domain);
      if (args.task_types)  args.task_types.split(',').forEach(t => params.append('task_types', t.trim()));
      if (args.trust_level) params.set('trust_level', args.trust_level);
      if (args.mode)        params.set('mode', args.mode);
      if (args.threshold)   params.set('threshold', args.threshold);
      if (args.k)           params.set('k', args.k);
      return olw('GET', `/query?${params}`);
    }

    case 'olw_pull':
      return olw('POST', '/pull', { intent: args.intent, constraints: { domain: args.domain, trust_level: args.trust_level }, k: args.k });

    case 'olw_resolve':
      return olw('GET', `/resolve?address=${encodeURIComponent(args.address)}`);

    case 'olw_keygen':
      return olw('POST', '/akashic/keygen', {});

    case 'olw_register_keys':
      return olw('POST', '/akashic/keys', { address: args.address, x25519_pub: args.x25519_pub, ed25519_pub: args.ed25519_pub });

    case 'olw_write_field': {
      if (!OLW_ADDRESS || !ED25519_PRIV || !X25519_PRIV) {
        return { error: 'OLW_ADDRESS, OLW_ED25519_PRIV, and OLW_X25519_PRIV env vars required for write' };
      }
      const namespace  = args.namespace || OLW_ADDRESS;
      const field_path = args.field_path;

      // Step 1: seal the plaintext to ourselves so the stored ciphertext is decryptable by us
      const sealed = await olw('POST', '/akashic/seal', { plaintext: args.plaintext, recipient_address: namespace });
      if (sealed.error) return sealed;
      const ciphertext = sealed.ciphertext;

      // Step 2: get current version to sign over
      const existing = await olw('POST', '/akashic/read', { requester: namespace, namespace, field_paths: [field_path] });
      const version = ((existing?.fields ?? [])[0]?.version ?? 0) + 1;

      // Step 3: sign the write payload
      const payload = writePayloadBytes(namespace, field_path, ciphertext, version);
      const signature = ed25519Sign(payload, ED25519_PRIV);

      return olw('POST', '/akashic/write', { writer: namespace, namespace, field_path, ciphertext, signature, propagation: args.propagation || 'local', ttl: args.ttl });
    }

    case 'olw_read_fields':
      return olw('POST', '/akashic/read', { requester: args.requester, namespace: args.namespace, field_paths: args.field_paths });

    case 'olw_grant': {
      if (!OLW_ADDRESS || !ED25519_PRIV) {
        return { error: 'OLW_ADDRESS and OLW_ED25519_PRIV env vars required for grant' };
      }
      const grantBody = {
        grantor:     OLW_ADDRESS,
        grantee:     args.grantee,
        fields:      args.fields,
        permissions: args.permissions,
        expires_at:  args.expires_at,
      };
      const signature = ed25519Sign(canonicalGrantBytes(grantBody), ED25519_PRIV);
      return olw('POST', '/akashic/grant', { ...grantBody, signature });
    }

    case 'olw_open': {
      if (!X25519_PRIV) return { error: 'OLW_X25519_PRIV env var required for decrypt' };
      return olw('POST', '/akashic/open', { ciphertext: args.ciphertext, x25519_priv: X25519_PRIV });
    }

    default:
      return { error: `unknown OLW function: ${name}` };
  }
}
