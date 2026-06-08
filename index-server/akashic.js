/**
 * akashic.js — The Akashic Layer
 * OLW Element 3: shared encrypted field state for sandboxed agents
 *
 * Crypto primitives (Node.js native crypto — no external deps):
 *   X25519  — ECDH key exchange (sealed box sender ephemeral key)
 *   Ed25519 — signing (field writes, grant creation)
 *   AES-256-GCM — authenticated encryption
 *   HKDF-SHA256 — key derivation from shared secret
 *
 * Sealed Box wire format:
 *   [ ephemeral_pub (32B) | nonce (12B) | ciphertext (varB) | tag (16B) ]
 */

import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';

// ── Paths ─────────────────────────────────────────────────────────────────────
const BASE = '/opt/olw/index-server';
const FIELDS_PATH  = `${BASE}/akashic-fields.json`;
const GRANTS_PATH  = `${BASE}/akashic-grants.json`;
const PUBKEYS_PATH = `${BASE}/akashic-pubkeys.json`;
const AUDIT_PATH   = `${BASE}/akashic-audit.jsonl`;

// ── DB helpers ────────────────────────────────────────────────────────────────
function loadFields()  { return existsSync(FIELDS_PATH)  ? JSON.parse(readFileSync(FIELDS_PATH,  'utf8')) : { fields: {} }; }
function saveFields(d) { writeFileSync(FIELDS_PATH,  JSON.stringify(d, null, 2)); }
function loadGrants()  { return existsSync(GRANTS_PATH)  ? JSON.parse(readFileSync(GRANTS_PATH,  'utf8')) : { grants: {} }; }
function saveGrants(d) { writeFileSync(GRANTS_PATH,  JSON.stringify(d, null, 2)); }
function loadPubkeys() { return existsSync(PUBKEYS_PATH) ? JSON.parse(readFileSync(PUBKEYS_PATH, 'utf8')) : { keys: {} }; }
function savePubkeys(d){ writeFileSync(PUBKEYS_PATH, JSON.stringify(d, null, 2)); }

// ── Audit log (append-only JSONL) ─────────────────────────────────────────────
function audit(entry) {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() });
  appendFileSync(AUDIT_PATH, line + '\n');
}

// ── Crypto: Sealed Box ────────────────────────────────────────────────────────

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/**
 * Encrypt plaintext to a recipient's X25519 public key (SPKI DER base64url).
 * Anonymous sealed box — no sender identity required.
 * Wire: ephemeral_pub_raw(32) | nonce(12) | ciphertext | GCM_tag(16) — all base64url.
 */
export function sealedBoxEncrypt(plaintextBuf, recipientX25519PubSpkiB64) {
  const recipSpki   = Buffer.from(recipientX25519PubSpkiB64, 'base64url');
  const recipPubRaw = recipSpki.slice(-32); // raw 32-byte key inside SPKI wrapper

  const recipKeyObj = crypto.createPublicKey({ key: recipSpki, format: 'der', type: 'spki' });

  const { privateKey: ephPriv, publicKey: ephPub } = crypto.generateKeyPairSync('x25519');
  const ephPubRaw = ephPub.export({ type: 'spki', format: 'der' }).slice(-32);

  const sharedSecret = crypto.diffieHellman({ privateKey: ephPriv, publicKey: recipKeyObj });

  // HKDF salt = ephemeral_raw(32) || recipient_raw(32) — both raw, consistent in decrypt
  const hkdfKey = crypto.hkdfSync(
    'sha256', sharedSecret,
    Buffer.concat([ephPubRaw, recipPubRaw]),
    Buffer.from('OLW-AkashicField-v1'), 32,
  );

  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', hkdfKey, nonce);
  const ct  = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([ephPubRaw, nonce, ct, tag]).toString('base64url');
}

/**
 * Decrypt a sealed box using the recipient's X25519 private key (PKCS8 DER base64url).
 * Returns plaintext Buffer or throws on auth failure.
 */
export function sealedBoxDecrypt(wireB64, recipientX25519PrivPkcs8B64) {
  const wire = Buffer.from(wireB64, 'base64url');
  if (wire.length < 32 + 12 + 16) throw new Error('ciphertext too short');

  const ephPubRaw = wire.subarray(0, 32);
  const nonce     = wire.subarray(32, 44);
  const tagOffset = wire.length - 16;
  const ct        = wire.subarray(44, tagOffset);
  const tag       = wire.subarray(tagOffset);

  const recipPrivKey = crypto.createPrivateKey({
    key: Buffer.from(recipientX25519PrivPkcs8B64, 'base64url'),
    format: 'der', type: 'pkcs8',
  });

  // Derive recipient raw public key (same slice as in encrypt)
  const recipPubRaw = crypto.createPublicKey(recipPrivKey)
    .export({ type: 'spki', format: 'der' }).slice(-32);

  // Reconstruct ephemeral public key from wire raw bytes
  const ephPubKey = crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, ephPubRaw]),
    format: 'der', type: 'spki',
  });

  const sharedSecret = crypto.diffieHellman({ privateKey: recipPrivKey, publicKey: ephPubKey });

  const hkdfKey = crypto.hkdfSync(
    'sha256', sharedSecret,
    Buffer.concat([ephPubRaw, recipPubRaw]),
    Buffer.from('OLW-AkashicField-v1'), 32,
  );

  const decipher = crypto.createDecipheriv('aes-256-gcm', hkdfKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── Crypto: Ed25519 signing ───────────────────────────────────────────────────

/** Sign data with an Ed25519 private key (DER base64url). Returns signature base64url. */
export function ed25519Sign(dataBuf, privKeyDerB64) {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(privKeyDerB64, 'base64url'),
    format: 'der', type: 'pkcs8',
  });
  return crypto.sign(null, dataBuf, privKey).toString('base64url');
}

/** Verify Ed25519 signature. pubKeyDerB64 is the SPKI DER base64url. */
export function ed25519Verify(dataBuf, sigB64, pubKeyDerB64) {
  const pubKey = crypto.createPublicKey({
    key: Buffer.from(pubKeyDerB64, 'base64url'),
    format: 'der', type: 'spki',
  });
  return crypto.verify(null, dataBuf, pubKey, Buffer.from(sigB64, 'base64url'));
}

// ── Key generation ────────────────────────────────────────────────────────────

/**
 * Generate a full OLW keypair for an address:
 *   x25519_pub / x25519_priv — for sealed box encryption
 *   ed25519_pub / ed25519_priv — for signing
 * Returns { x25519_pub, x25519_priv, ed25519_pub, ed25519_priv } all base64url DER.
 * CALLER MUST store priv keys securely — server never retains them.
 */
export function generateKeypair() {
  const { privateKey: xPriv, publicKey: xPub } = crypto.generateKeyPairSync('x25519');
  const { privateKey: ePriv, publicKey: ePub } = crypto.generateKeyPairSync('ed25519');
  return {
    x25519_pub:   xPub.export({ type: 'spki',  format: 'der' }).toString('base64url'),
    x25519_priv:  xPriv.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
    ed25519_pub:  ePub.export({ type: 'spki',  format: 'der' }).toString('base64url'),
    ed25519_priv: ePriv.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}

// ── Public key registry ───────────────────────────────────────────────────────

/**
 * Register public keys for an OLW address.
 * Does NOT store private keys — those stay with the agent.
 */
export function registerPubkeys(address, x25519_pub, ed25519_pub) {
  validateAddress(address);
  const db = loadPubkeys();
  db.keys[address] = {
    address,
    x25519_pub,
    ed25519_pub,
    registered_at: new Date().toISOString(),
  };
  savePubkeys(db);
  audit({ op: 'register_keys', address });
  return db.keys[address];
}

export function getPubkeys(address) {
  const db = loadPubkeys();
  return db.keys[address] || null;
}

// ── Grant management ─────────────────────────────────────────────────────────

/**
 * Create and store an AkashicGrant.
 * The grantor must sign the grant body with their Ed25519 key.
 *
 * grantBody: { grantor, grantee, fields, permissions, expires_at, conditions? }
 * signature: ed25519Sign(canonicalGrantBytes, grantor_ed25519_priv)
 */
export function createGrant(grantBody, signatureB64) {
  const { grantor, grantee, fields, permissions, expires_at } = grantBody;

  if (!grantor || !grantee || !fields || !permissions || !expires_at) {
    throw new Error('grant missing required fields: grantor, grantee, fields, permissions, expires_at');
  }
  validateAddress(grantor);
  validateAddress(grantee);
  if (new Date(expires_at) <= new Date()) throw new Error('expires_at must be in the future');
  if (!Array.isArray(permissions) || permissions.length === 0) throw new Error('permissions must be non-empty array');
  const VALID_PERMS = ['read', 'write', 'subscribe'];
  permissions.forEach(p => { if (!VALID_PERMS.includes(p)) throw new Error(`invalid permission: ${p}`); });

  // Verify grantor's signature over canonical grant bytes
  const canonical = canonicalGrantBytes(grantBody);
  const keys = getPubkeys(grantor);
  if (!keys) throw new Error(`no public keys registered for grantor: ${grantor}`);
  if (!ed25519Verify(canonical, signatureB64, keys.ed25519_pub)) {
    throw new Error('grant signature invalid — must be signed by grantor Ed25519 key');
  }

  const grantId = `grant_${crypto.randomBytes(16).toString('hex')}`;
  const grant = {
    id: grantId,
    ...grantBody,
    signature: signatureB64,
    created_at: new Date().toISOString(),
    revoked: false,
  };

  const db = loadGrants();
  db.grants[grantId] = grant;
  saveGrants(db);
  audit({ op: 'create_grant', grant_id: grantId, grantor, grantee, fields, permissions, expires_at });
  return grant;
}

/**
 * Revoke a grant. Only the grantor can revoke.
 * revocation_sig: ed25519Sign(Buffer.from(grantId), grantor_ed25519_priv)
 */
export function revokeGrant(grantId, revokerAddress, revocationSigB64) {
  const db = loadGrants();
  const grant = db.grants[grantId];
  if (!grant) throw new Error('grant not found');
  if (grant.grantor !== revokerAddress) throw new Error('only the grantor can revoke a grant');

  const keys = getPubkeys(revokerAddress);
  if (!keys) throw new Error('no public keys registered for revoker');
  if (!ed25519Verify(Buffer.from(grantId), revocationSigB64, keys.ed25519_pub)) {
    throw new Error('revocation signature invalid');
  }

  grant.revoked = true;
  grant.revoked_at = new Date().toISOString();
  saveGrants(db);
  audit({ op: 'revoke_grant', grant_id: grantId, grantor: revokerAddress });
  return { revoked: true, grant_id: grantId };
}

/** Check if grantee has a valid, non-expired, non-revoked grant from grantor for field_path + permission. */
export function checkGrant(grantor, grantee, field_path, permission) {
  const db = loadGrants();
  const now = new Date();
  return Object.values(db.grants).some(g =>
    g.grantor === grantor &&
    g.grantee === grantee &&
    !g.revoked &&
    new Date(g.expires_at) > now &&
    g.permissions.includes(permission) &&
    g.fields.some(f => fieldPathMatches(f, field_path))
  );
}

// ── Field operations ──────────────────────────────────────────────────────────

/**
 * Write an encrypted field to the Akashic Layer.
 *
 * writer:      OLW address of the writing agent
 * namespace:   OLW address that owns this field namespace (writer must == namespace OR have 'write' grant)
 * field_path:  hierarchical path, e.g. "session.context.summary"
 * ciphertext:  base64url-encoded sealed box (use sealedBoxEncrypt to produce)
 * signature:   ed25519Sign(writePayloadBytes(namespace, field_path, ciphertext, version), writer_priv)
 * propagation: "local" | "regional" | "global" | "directed"
 * ttl:         seconds, optional
 */
export function writeField({ writer, namespace, field_path, ciphertext, signature, propagation = 'local', ttl = null }) {
  validateAddress(writer);
  validateAddress(namespace);
  validateFieldPath(field_path);

  // Authorization: writer must be namespace owner OR have write grant
  if (writer !== namespace && !checkGrant(namespace, writer, field_path, 'write')) {
    throw new Error(`write denied: ${writer} has no write grant on ${namespace}/${field_path}`);
  }

  const keys = getPubkeys(writer);
  if (!keys) throw new Error(`no public keys registered for writer: ${writer}`);

  const db = loadFields();
  const key = `${namespace}::${field_path}`;
  const existing = db.fields[key];
  // Version = head node's version + 1, or 1 for a new field.
  // (existing?.dag?.[existing?.head]?.version matches Python: sum(vector_clock.values()) after increment)
  const currentVersion = existing?.dag?.[existing?.head]?.version ?? 0;
  const version = currentVersion + 1;

  // Verify signature over: namespace || field_path || ciphertext || version
  const payload = writePayloadBytes(namespace, field_path, ciphertext, version);
  if (!ed25519Verify(payload, signature, keys.ed25519_pub)) {
    throw new Error('write signature invalid — must be signed by writer Ed25519 key');
  }

  const expires_at = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null;
  const written_at = new Date().toISOString();

  // ── Merkle-DAG node ──────────────────────────────────────────────────────
  // Each write appends a new content-addressed node; prior versions are kept.
  // This implements the FieldCRDT "merkle_dag" strategy from rsb/rsb.py.
  const nodeContent = JSON.stringify({
    version, writer, written_at,
    parent: existing?.head ?? null,
  }, null, 0);
  const nodeHash = crypto.createHash('sha256').update(nodeContent).digest('hex');

  const newNode = { version, ciphertext, writer, signature, written_at, parent: existing?.head ?? null };

  const updatedField = {
    namespace, field_path, propagation, ttl, expires_at,
    // CRDT state
    head: nodeHash,
    vector_clock: { ...(existing?.vector_clock ?? {}), [writer]: (existing?.vector_clock?.[writer] ?? 0) + 1 },
    dag: { ...(existing?.dag ?? {}), [nodeHash]: newNode },
  };

  db.fields[key] = updatedField;
  saveFields(db);
  audit({ op: 'write_field', writer, namespace, field_path, version, propagation, node_hash: nodeHash });
  return { written: true, namespace, field_path, version, node_hash: nodeHash };
}

/**
 * Read encrypted field(s) for a requester.
 * Returns ciphertext only — decryption happens client-side.
 * The requester must be the namespace owner OR have a 'read' grant.
 *
 * namespace_filter: optional, filter to one namespace
 * field_paths:      optional array of field paths to fetch (default: all accessible)
 */
export function readFields({ requester, namespace, field_paths = null }) {
  validateAddress(requester);

  const db = loadFields();
  const now = new Date();
  const results = [];

  for (const [key, field] of Object.entries(db.fields)) {
    // Skip expired fields
    if (field.expires_at && new Date(field.expires_at) <= now) continue;
    // Namespace filter
    if (namespace && field.namespace !== namespace) continue;
    // Path filter
    if (field_paths && !field_paths.some(p => fieldPathMatches(p, field.field_path))) continue;
    // Authorization
    const isOwner = requester === field.namespace;
    const hasGrant = checkGrant(field.namespace, requester, field.field_path, 'read');
    if (!isOwner && !hasGrant) continue;

    // Read head node from Merkle-DAG
    const headNode = field.dag?.[field.head];
    if (!headNode) continue;   // malformed entry

    results.push({
      namespace: field.namespace,
      field_path: field.field_path,
      ciphertext: headNode.ciphertext,
      version: headNode.version,
      writer: headNode.writer,
      written_at: headNode.written_at,
      propagation: field.propagation,
      node_hash: field.head,
    });
    audit({ op: 'read_field', requester, namespace: field.namespace, field_path: field.field_path });
  }

  return results;
}

/**
 * Right to Erasure — delete all fields in a namespace.
 * Only the namespace owner can erase. Requires Ed25519 signature over the namespace string.
 */
export function eraseNamespace(namespace, ownerAddress, erasureSigB64) {
  validateAddress(namespace);
  if (namespace !== ownerAddress) throw new Error('only the namespace owner can erase');

  const keys = getPubkeys(ownerAddress);
  if (!keys) throw new Error('no public keys registered for owner');
  if (!ed25519Verify(Buffer.from(namespace), erasureSigB64, keys.ed25519_pub)) {
    throw new Error('erasure signature invalid');
  }

  const db = loadFields();
  let erased = 0;
  for (const key of Object.keys(db.fields)) {
    if (db.fields[key].namespace === namespace) {
      delete db.fields[key];
      erased++;
    }
  }
  saveFields(db);

  // Revoke all grants from this namespace
  const grants = loadGrants();
  let grantsRevoked = 0;
  for (const g of Object.values(grants.grants)) {
    if (g.grantor === namespace && !g.revoked) {
      g.revoked = true;
      g.revoked_at = new Date().toISOString();
      grantsRevoked++;
    }
  }
  saveGrants(grants);
  audit({ op: 'erase_namespace', namespace, owner: ownerAddress, fields_erased: erased, grants_revoked: grantsRevoked });

  return { erased: true, namespace, fields_erased: erased, grants_revoked: grantsRevoked };
}

// ── Audit log reader ──────────────────────────────────────────────────────────

/**
 * Read audit log entries for a specific address (as any party in an operation).
 * Returns array of log entries, newest first. Max 500 entries.
 */
export function readAuditLog(address, limit = 100) {
  if (!existsSync(AUDIT_PATH)) return [];
  const lines = readFileSync(AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
  const entries = lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && (e.address === address || e.grantor === address || e.grantee === address ||
                        e.writer === address || e.requester === address || e.namespace === address || e.owner === address));
  return entries.reverse().slice(0, Math.min(limit, 500));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function validateAddress(addr) {
  if (!addr || !/^[a-z0-9-]{1,64}@[a-z0-9.-]+\.olw$/.test(addr)) {
    throw new Error(`invalid OLW address: ${addr} (expected id@owner.olw)`);
  }
}

function validateFieldPath(path) {
  if (!path || !/^[a-zA-Z0-9._-]{1,256}$/.test(path)) {
    throw new Error(`invalid field_path: ${path} (alphanumeric, dots, hyphens, underscores, max 256)`);
  }
}

/** Canonical bytes to sign for a grant — deterministic JSON of sorted keys. */
function canonicalGrantBytes(grantBody) {
  const sorted = Object.fromEntries(
    ['grantor', 'grantee', 'fields', 'permissions', 'expires_at', 'conditions']
      .filter(k => grantBody[k] !== undefined)
      .map(k => [k, grantBody[k]])
  );
  return Buffer.from(JSON.stringify(sorted));
}

/** Canonical bytes to sign for a field write. */
export function writePayloadBytes(namespace, field_path, ciphertext, version) {
  return Buffer.from(`${namespace}|${field_path}|${ciphertext}|${version}`);
}

/** Match a grant field pattern (supports '*' wildcard) against a concrete field path. */
function fieldPathMatches(pattern, path) {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return path === prefix || path.startsWith(prefix + '.');
  }
  return pattern === path;
}

// ── Health stats ──────────────────────────────────────────────────────────────
export function akashicStats() {
  const fields  = loadFields();
  const grants  = loadGrants();
  const keys    = loadPubkeys();
  const now = new Date();
  const activeFields = Object.values(fields.fields).filter(f => !f.expires_at || new Date(f.expires_at) > now).length;
  const activeGrants = Object.values(grants.grants).filter(g => !g.revoked && new Date(g.expires_at) > now).length;
  return {
    registered_addresses: Object.keys(keys.keys).length,
    fields_total: Object.keys(fields.fields).length,
    fields_active: activeFields,
    grants_total: Object.keys(grants.grants).length,
    grants_active: activeGrants,
  };
}

/** Full Akashic data for the admin portal — address list, active fields, active grants. */
export function akashicAdminData() {
  const fields  = loadFields();
  const grants  = loadGrants();
  const keys    = loadPubkeys();
  const now = new Date();

  const addresses = Object.values(keys.keys).map(k => ({
    address: k.address,
    registered_at: k.registered_at,
    field_count: Object.values(fields.fields).filter(f => f.namespace === k.address).length,
    grant_count: Object.values(grants.grants).filter(g => g.grantor === k.address && !g.revoked && new Date(g.expires_at) > now).length,
  }));

  const activeFields = Object.values(fields.fields)
    .filter(f => !f.expires_at || new Date(f.expires_at) > now)
    .map(f => ({
      namespace: f.namespace,
      field_path: f.field_path,
      version: f.version,
      writer: f.writer,
      propagation: f.propagation,
      written_at: f.written_at,
      expires_at: f.expires_at,
    }));

  const activeGrants = Object.values(grants.grants)
    .filter(g => !g.revoked && new Date(g.expires_at) > now)
    .map(g => ({
      id: g.id,
      grantor: g.grantor,
      grantee: g.grantee,
      fields: g.fields,
      permissions: g.permissions,
      expires_at: g.expires_at,
      created_at: g.created_at,
    }));

  return { stats: akashicStats(), addresses, fields: activeFields, grants: activeGrants };
}
