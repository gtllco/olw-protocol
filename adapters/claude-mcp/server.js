#!/usr/bin/env node
/**
 * OLW Akashic Layer — Claude MCP Tool Adapter
 *
 * Exposes Akashic read/write/grant operations as MCP tools.
 * Claude calls these tools through permitted ingestion channels.
 * The sandbox is never broken. The field permeates.
 *
 * Usage:
 *   node server.js
 *
 * Config (env or config.json):
 *   OLW_ADDRESS     — e.g. "my-agent@owner.olw"
 *   OLW_INDEX_URL   — default: https://olw.gtll.app
 *   OLW_ED25519_PRIV — base64url PKCS8 DER Ed25519 private key
 *   OLW_X25519_PRIV  — base64url PKCS8 DER X25519 private key
 *   OLW_API_KEY      — optional Pro API key
 *
 * MCP protocol: stdio transport (stdin/stdout JSON-RPC 2.0)
 */

import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH = new URL('./config.json', import.meta.url).pathname;
const cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};

const OLW_ADDRESS   = process.env.OLW_ADDRESS    || cfg.olw_address    || '';
const INDEX_URL     = process.env.OLW_INDEX_URL  || cfg.index_url      || 'https://olw.gtll.app';
const ED25519_PRIV  = process.env.OLW_ED25519_PRIV || cfg.ed25519_priv || '';
const X25519_PRIV   = process.env.OLW_X25519_PRIV  || cfg.x25519_priv  || '';
const API_KEY       = process.env.OLW_API_KEY    || cfg.api_key        || '';

// ── Crypto helpers ────────────────────────────────────────────────────────────

function ed25519Sign(dataBuf, privKeyB64) {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(privKeyB64, 'base64url'),
    format: 'der', type: 'pkcs8',
  });
  return crypto.sign(null, dataBuf, privKey).toString('base64url');
}

function writePayloadBytes(namespace, field_path, ciphertext, version) {
  return Buffer.from(`${namespace}|${field_path}|${ciphertext}|${version}`);
}

function canonicalGrantBytes(grant) {
  const sorted = Object.fromEntries(
    ['grantor','grantee','fields','permissions','expires_at','conditions']
      .filter(k => grant[k] !== undefined)
      .map(k => [k, grant[k]])
  );
  return Buffer.from(JSON.stringify(sorted));
}

// ── Index API calls ───────────────────────────────────────────────────────────

async function indexCall(method, path, body = null) {
  const url = `${INDEX_URL}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json();
}

// ── MCP Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'akashic_keygen',
    description: 'Generate a fresh OLW keypair (X25519 + Ed25519). Store private keys securely — the server never retains them.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'akashic_register_keys',
    description: 'Register your public keys with the OLW index for an OLW address. Required before writing fields or creating grants.',
    inputSchema: {
      type: 'object',
      properties: {
        address:     { type: 'string', description: 'OLW address, e.g. my-agent@owner.olw' },
        x25519_pub:  { type: 'string', description: 'base64url SPKI DER X25519 public key' },
        ed25519_pub: { type: 'string', description: 'base64url SPKI DER Ed25519 public key' },
      },
      required: ['address', 'x25519_pub', 'ed25519_pub'],
    },
  },
  {
    name: 'akashic_write',
    description: 'Encrypt a value as a sealed box and write it as an Akashic field. Writer must be namespace owner or have a write grant.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace:   { type: 'string', description: 'OLW address that owns the field namespace' },
        field_path:  { type: 'string', description: 'Hierarchical field path, e.g. session.context.summary' },
        value:       { type: 'string', description: 'Plaintext value to encrypt and store' },
        recipient:   { type: 'string', description: 'OLW address whose public key to encrypt to (default: namespace owner)' },
        propagation: { type: 'string', enum: ['local','regional','global','directed'], description: 'Propagation scope (default: local)' },
        ttl:         { type: 'number', description: 'Time-to-live in seconds (optional, default: persistent)' },
      },
      required: ['namespace', 'field_path', 'value'],
    },
  },
  {
    name: 'akashic_read',
    description: 'Read Akashic fields from the layer. Returns ciphertext. If x25519_priv is configured, decrypts automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace:   { type: 'string', description: 'OLW namespace to read from (optional filter)' },
        field_paths: { type: 'array', items: { type: 'string' }, description: 'Specific field paths to read (optional filter)' },
      },
      required: [],
    },
  },
  {
    name: 'akashic_grant',
    description: 'Create a signed consent grant allowing another agent to read or write fields in your namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        grantee:     { type: 'string', description: 'OLW address of the agent receiving access' },
        fields:      { type: 'array', items: { type: 'string' }, description: 'Field path patterns to grant access to (e.g. ["session.*", "trip.status"])' },
        permissions: { type: 'array', items: { type: 'string', enum: ['read','write','subscribe'] }, description: 'Permissions to grant' },
        expires_at:  { type: 'string', description: 'ISO 8601 expiry datetime (e.g. 2026-12-31T00:00:00Z)' },
      },
      required: ['grantee', 'fields', 'permissions', 'expires_at'],
    },
  },
  {
    name: 'akashic_revoke',
    description: 'Instantly revoke a consent grant you previously created.',
    inputSchema: {
      type: 'object',
      properties: {
        grant_id: { type: 'string', description: 'The grant ID to revoke (from akashic_grant response)' },
      },
      required: ['grant_id'],
    },
  },
  {
    name: 'akashic_audit',
    description: 'Read your audit log — all reads and writes to/from your OLW address.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default: 50, max: 500)' },
      },
      required: [],
    },
  },
  {
    name: 'akashic_stats',
    description: 'Get public statistics on the Akashic Layer.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {

    case 'akashic_keygen': {
      return indexCall('POST', '/akashic/keygen', {});
    }

    case 'akashic_register_keys': {
      const { address, x25519_pub, ed25519_pub } = args;
      return indexCall('POST', '/akashic/keys', { address, x25519_pub, ed25519_pub });
    }

    case 'akashic_write': {
      if (!OLW_ADDRESS || !ED25519_PRIV) {
        return { error: 'OLW_ADDRESS and OLW_ED25519_PRIV must be configured to write fields' };
      }
      const { namespace, field_path, value, recipient, propagation = 'local', ttl } = args;
      const recipientAddr = recipient || namespace;

      // Get recipient's public key for sealing
      const keysRes = await indexCall('GET', `/akashic/keys?address=${encodeURIComponent(recipientAddr)}`);
      if (!keysRes.ok) return { error: `no public keys for recipient: ${recipientAddr}` };

      // Encrypt value as sealed box
      const sealRes = await indexCall('POST', '/akashic/seal', {
        plaintext: value,
        recipient_address: recipientAddr,
      });
      if (!sealRes.ok) return { error: `seal failed: ${sealRes.error}` };
      const ciphertext = sealRes.ciphertext;

      // Determine version by reading current field (0 if new)
      let version = 1;
      try {
        const readRes = await indexCall('POST', '/akashic/read', {
          requester: OLW_ADDRESS, namespace, field_paths: [field_path],
        });
        if (readRes.ok && readRes.fields.length > 0) {
          version = readRes.fields[0].version + 1;
        }
      } catch { /* new field */ }

      // Sign write payload
      const payload = writePayloadBytes(namespace, field_path, ciphertext, version);
      const signature = ed25519Sign(payload, ED25519_PRIV);

      return indexCall('POST', '/akashic/write', {
        writer: OLW_ADDRESS, namespace, field_path, ciphertext, signature, propagation,
        ...(ttl !== undefined && { ttl }),
      });
    }

    case 'akashic_read': {
      if (!OLW_ADDRESS) return { error: 'OLW_ADDRESS must be configured to read fields' };
      const { namespace, field_paths } = args;
      const readRes = await indexCall('POST', '/akashic/read', {
        requester: OLW_ADDRESS,
        ...(namespace && { namespace }),
        ...(field_paths && { field_paths }),
      });

      // If private key configured, attempt decryption
      if (readRes.ok && X25519_PRIV && readRes.fields) {
        for (const f of readRes.fields) {
          try {
            const openRes = await indexCall('POST', '/akashic/open', {
              ciphertext: f.ciphertext,
              x25519_priv: X25519_PRIV,
            });
            if (openRes.ok) {
              f.plaintext = openRes.plaintext;
              delete f.ciphertext; // don't return raw ciphertext when decrypted
            }
          } catch { /* leave as ciphertext */ }
        }
      }
      return readRes;
    }

    case 'akashic_grant': {
      if (!OLW_ADDRESS || !ED25519_PRIV) {
        return { error: 'OLW_ADDRESS and OLW_ED25519_PRIV must be configured to create grants' };
      }
      const { grantee, fields, permissions, expires_at } = args;
      const grantBody = { grantor: OLW_ADDRESS, grantee, fields, permissions, expires_at };
      const signature = ed25519Sign(canonicalGrantBytes(grantBody), ED25519_PRIV);
      return indexCall('POST', '/akashic/grant', { grant: grantBody, signature });
    }

    case 'akashic_revoke': {
      if (!OLW_ADDRESS || !ED25519_PRIV) {
        return { error: 'OLW_ADDRESS and OLW_ED25519_PRIV must be configured to revoke grants' };
      }
      const { grant_id } = args;
      const revocation_signature = ed25519Sign(Buffer.from(grant_id), ED25519_PRIV);
      return indexCall('DELETE', '/akashic/grant', {
        grant_id, revoker_address: OLW_ADDRESS, revocation_signature,
      });
    }

    case 'akashic_audit': {
      if (!OLW_ADDRESS) return { error: 'OLW_ADDRESS must be configured to read audit log' };
      const limit = args.limit || 50;
      return indexCall('GET', `/akashic/audit?address=${encodeURIComponent(OLW_ADDRESS)}&limit=${limit}`);
    }

    case 'akashic_stats': {
      return indexCall('GET', '/akashic/stats');
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}

// ── MCP stdio JSON-RPC 2.0 server ─────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });
const respond = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }

  const { id, method, params } = req;

  if (method === 'initialize') {
    respond({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'olw-akashic', version: '1.1.0' },
      },
    });
    return;
  }

  if (method === 'tools/list') {
    respond({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    try {
      const result = await executeTool(name, args || {});
      respond({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      });
    } catch (e) {
      respond({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true },
      });
    }
    return;
  }

  // ping / notifications/initialized
  if (method === 'ping') { respond({ jsonrpc: '2.0', id, result: {} }); return; }
  if (!id) return; // notification, no response needed

  respond({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});
