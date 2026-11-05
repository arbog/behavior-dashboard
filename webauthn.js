'use strict';
// ---- 0015: WebAuthn primitives (zero-dependency) ----
// The pure half of passkey support: a bounded CBOR decoder (registration
// attestation is the only place WebAuthn needs CBOR), COSE-key → node:crypto
// KeyObject, authenticator-data parsing, and the single-use challenge store.
// Everything here is deterministic and unit-tested against RFC 8949 vectors
// and real generated keys (docs/research/webauthn.md — verified on Node 22).
const crypto = require('crypto');

// ---------- base64url ----------
const b64u = buf => Buffer.from(buf).toString('base64url');
const b64uToBuf = s => Buffer.from(String(s), 'base64url');
const sha256 = b => crypto.createHash('sha256').update(b).digest();

// ---------- bounded CBOR decode (RFC 8949 subset) ----------
// WebAuthn emits definite lengths only. The bounds are the point: a hostile
// attestationObject must not allocate without bound — cap depth, item count,
// and total byte span. (Sizes the spec actually produces: ~1–2 KB.)
//
// decodeFrom(buf, pos) → { value, pos } for one item starting at pos.
function decodeFrom(buf, pos, st) {
  if (st.depth > (st.maxDepth ?? 8)) throw new Error('cbor: too deep');
  if (++st.items > (st.maxItems ?? 512)) throw new Error('cbor: too many items');
  if (pos >= buf.length) throw new Error('cbor: truncated');
  const ib = buf[pos++];
  const mt = ib >> 5, ai = ib & 31;
  let len;
  if (ai < 24) len = ai;
  else if (ai === 24) len = buf.readUInt8(pos++);
  else if (ai === 25) { len = buf.readUInt16BE(pos); pos += 2; }
  else if (ai === 26) { len = buf.readUInt32BE(pos); pos += 4; }
  else if (ai === 27) { len = Number(buf.readBigUInt64BE(pos)); pos += 8; }
  else throw new Error('cbor: indefinite or reserved length');
  switch (mt) {
    case 0: return { value: len, pos };
    case 1: return { value: -1 - len, pos };
    case 2: case 3: {
      if (len > buf.length || pos + len > buf.length) throw new Error('cbor: length beyond buffer');
      if (buf.length > (st.maxBytes ?? 1 << 20)) throw new Error('cbor: too large');
      const b = buf.subarray(pos, pos + len);
      return { value: mt === 2 ? b : b.toString('utf8'), pos: pos + len };
    }
    case 4: {
      const out = [];
      st.depth++;
      for (let i = 0; i < len; i++) { const r = decodeFrom(buf, pos, st); out.push(r.value); pos = r.pos; }
      st.depth--;
      return { value: out, pos };
    }
    case 5: {
      const out = {};
      st.depth++;
      for (let i = 0; i < len; i++) {
        const k = decodeFrom(buf, pos, st);
        const v = decodeFrom(buf, k.pos, st);
        out[typeof k.value === 'string' ? k.value : String(k.value)] = v.value;
        pos = v.pos;
      }
      st.depth--;
      return { value: out, pos };
    }
    case 7:
      if (len === 20) return { value: false, pos };   // 0xf4
      if (len === 21) return { value: true, pos };    // 0xf5
      if (len === 22) return { value: null, pos };
      throw new Error('cbor: unsupported simple value ' + len);
    default:
      throw new Error('cbor: unsupported major type ' + mt);
  }
}
const cborDecode = (buf, opts = {}) => {
  if (!Buffer.isBuffer(buf)) throw new Error('cbor: not a buffer');
  const st = { items: 0, depth: 0, ...opts };
  const r = decodeFrom(buf, 0, st);
  if (r.pos !== buf.length) throw new Error('cbor: trailing bytes');
  return r.value;
};

// ---------- COSE key → node:crypto KeyObject ----------
// Only the three algs real platform authenticators emit: ES256 (-7),
// EdDSA/Ed25519 (-8), RS256 (-257). The wrapper prefix is what node:crypto
// needs for a raw Ed25519 public key (research doc: bare raw is rejected).
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function coseKey(pub) {
  const alg = pub[3], kty = pub[1];
  if (kty === 2 && (alg === -7 || alg === -35)) {   // EC2
    const crv = { 1: 'P-256', 3: 'P-384' }[pub[-1]];
    if (!crv) throw new Error('cose: unsupported curve ' + pub[-1]);
    const jwk = { kty: 'EC', crv, x: b64u(pub[-2]), y: b64u(pub[-3]), alg: alg === -7 ? 'ES256' : 'ES384' };
    return { key: crypto.createPublicKey({ format: 'jwk', key: jwk }), hash: alg === -7 ? 'sha256' : 'sha384', jwk };
  }
  if (kty === 1 && alg === -8) {                    // OKP Ed25519
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: b64u(pub[-2]), alg: 'EdDSA' };
    return { key: crypto.createPublicKey({ format: 'jwk', key: jwk }), hash: null, jwk };
  }
  if (kty === 3 && alg === -257) {                  // RSA
    const jwk = { kty: 'RSA', n: b64u(pub[-1]), e: b64u(pub[-2]), alg: 'RS256' };
    return { key: crypto.createPublicKey({ format: 'jwk', key: jwk }), hash: 'sha256', jwk };
  }
  throw new Error('cose: unsupported key alg ' + alg);
}

// ---------- authenticator data ----------
// 32 rpIdHash | 1 flags | 4 signCount | [attestedCredentialData] | [extensions]
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;
function parseAuthData(authData) {
  if (!Buffer.isBuffer(authData) || authData.length < 37) throw new Error('authData: too short');
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  let pos = 37;
  let credential = null;
  if (flags & FLAG_AT) {
    if (authData.length < pos + 18) throw new Error('authData: no room for credential');
    const aaguid = authData.subarray(pos, pos + 16); pos += 16;
    const idLen = authData.readUInt16BE(pos); pos += 2;
    if (authData.length < pos + idLen) throw new Error('authData: truncated credential id');
    const id = authData.subarray(pos, pos + idLen); pos += idLen;
    // The COSE public key: attestedCredentialData ends where the key ends
    // (extensions follow and are rare — and rejected here as trailing bytes,
    // which a v1 board may refuse). decodeFrom returns the exact end offset.
    const r = decodeFrom(authData, pos, { items: 0, depth: 0, maxDepth: 8 });
    if (!r.value || typeof r.value !== 'object' || Buffer.isBuffer(r.value)) throw new Error('authData: no COSE key');
    credential = { aaguid, id, pub: r.value };
    pos = r.pos;
  }
  if (pos !== authData.length) throw new Error('authData: trailing bytes (extensions not supported)');
  return { rpIdHash, flags, signCount, up: !!(flags & FLAG_UP), uv: !!(flags & FLAG_UV), at: !!(flags & FLAG_AT), credential };
}

// ---------- challenge store (in-memory, single use, TTL) ----------
const challenges = new Map();
const CHALLENGE_TTL = 60000, CHALLENGE_MAX = 100;
function newChallenge(purpose, user = 'admin') {
  sweepChallenges();
  if (challenges.size >= CHALLENGE_MAX) {   // bound memory: drop the oldest
    challenges.delete([...challenges.keys()][0]);
  }
  const c = crypto.randomBytes(32);
  challenges.set(c.toString('base64url'), { purpose, user, expires: Date.now() + CHALLENGE_TTL });
  return b64u(c);
}
function takeChallenge(s, purpose) {
  sweepChallenges();
  const rec = challenges.get(String(s));
  challenges.delete(String(s));          // single use, always
  if (!rec || rec.purpose !== purpose || rec.expires <= Date.now()) return null;
  return rec;
}
function sweepChallenges() {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires <= now) challenges.delete(k);
}

// ---------- client data (shared by register + authenticate) ----------
// clientDataJSON must carry the right type, our challenge, and our origin.
function checkClientData(clientDataJSON, expected) {
  let cd;
  try { cd = JSON.parse(Buffer.from(String(clientDataJSON), 'base64url').toString('utf8')); } catch { return { error: 'client data did not parse' }; }
  if (cd.type !== expected.type) return { error: 'wrong ceremony type' };
  if (String(cd.challenge) !== String(expected.challenge)) return { error: 'challenge mismatch' };
  if (cd.origin !== expected.origin) return { error: 'origin mismatch' };
  return { cd, clientDataJSON };
}

module.exports = { b64u, b64uToBuf, sha256, cborDecode, decodeFrom, coseKey, parseAuthData, newChallenge, takeChallenge, checkClientData, FLAG_UP, FLAG_UV, FLAG_AT, ED25519_SPKI, challenges: () => challenges };
