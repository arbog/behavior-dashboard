'use strict';
// Passkey tests (0015): the CBOR decoder against RFC 8949 vectors, the COSE
// key converter against real generated keys, and a fake authenticator that
// walks the whole registration + assertion flow over HTTP.
process.env.DB_PATH = ':memory:';
process.env.SETUP_TOKEN = 'pk-suite-setup-token-1234';
process.env.LOGIN_RATE_LIMIT = '1000';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const W = require('./webauthn.js');
const { server } = require('./server.js');

let PW = 'correct-horse-battery';
let base, cookie;

// ---- a tiny CBOR encoder — test-side only, for building fixtures ----
const encHead = (mt, n) => {
  const m = mt << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 256) return Buffer.from([m | 24, n]);
  if (n < 65536) return Buffer.from([m | 25, n >> 8, n & 255]);
  if (n < 4294967296) return Buffer.from([m | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  throw new Error('test encoder: 64-bit length not needed');
};
const enc = v => {
  if (typeof v === 'number') return v < 0 ? encHead(1, -1 - v) : encHead(0, v);
  if (typeof v === 'string') return Buffer.concat([encHead(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([encHead(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([encHead(4, v.length), ...v.map(enc)]);
  if (v && typeof v === 'object') return Buffer.concat([encHead(5, Object.keys(v).length), ...Object.entries(v).flatMap(([k, val]) => [enc(Number.isNaN(Number(k)) ? k : Number(k)), enc(val)])]);
  if (v === true) return Buffer.from([0xf5]); if (v === false) return Buffer.from([0xf4]);
  throw new Error('test encoder: unsupported ' + typeof v);
};

test.before(async () => {
  await new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  const s = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW, child_name: 'Sam', token: process.env.SETUP_TOKEN }) });
  cookie = s.headers.get('set-cookie').split(';')[0];
});
test.after(() => server.close());
const api = async (method, p, body, hdr = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie, ...hdr }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};

// ---- CBOR: RFC 8949 Appendix A vectors ----
test('cborDecode: RFC 8949 vectors', () => {
  const d = b => W.cborDecode(Buffer.from(b, 'hex'));
  assert.equal(d('00'), 0);
  assert.equal(d('17'), 23);
  assert.equal(d('1818'), 24);
  assert.equal(d('1903e8'), 1000);
  assert.equal(d('20'), -1);
  assert.equal(d('3903e7'), -1000);
  assert.equal(d('6449455446'), 'IETF');
  assert.deepEqual(d('80'), []);
  assert.deepEqual(d('a0'), {});
  assert.equal(d('f5'), true);
  assert.equal(d('f4'), false);
  assert.deepEqual(d('a201020304'), { 1: 2, 3: 4 });   // {1: 2, 3: 4}
  assert.deepEqual(d('a26161016162820203'), { a: 1, b: [2, 3] });   // {"a": 1, "b": [2, 3]}
  assert.deepEqual(d('820363616263'), [3, 'abc']);                    // [3, "abc"]
  assert.deepEqual(d('a343626172046161016162820203'), { bar: 4, a: 1, b: [2, 3] });
});
test('cborDecode is hostile-input-safe', () => {
  assert.throws(() => W.cborDecode(Buffer.from('5f', 'hex')), /indefinite|reserved/, 'indefinite lengths refused');
  assert.throws(() => W.cborDecode(Buffer.from('0101', 'hex')), /trailing/);   // valid item, then garbage
  assert.throws(() => W.cborDecode(Buffer.from('a15f', 'hex')), /indefinite|truncated/);
  assert.throws(() => W.cborDecode(Buffer.from('8201', 'hex')), /truncated/, 'declared array element missing');
  // a deeply-nested attack runs out of depth, not memory
  const deep = Buffer.concat([Buffer.from('81'.repeat(40), 'hex'), Buffer.from('01', 'hex')]);
  assert.throws(() => W.cborDecode(deep), /too deep/);
  // a huge declared byte string: refused, and the refusal is cheap
  assert.throws(() => W.cborDecode(Buffer.concat([Buffer.from('5a', 'hex'), Buffer.from([0x7f, 0xff, 0xff, 0xff]), Buffer.alloc(8)])), /length beyond buffer|truncated/);
});

// ---- COSE keys: real generated keys verify ----
test('coseKey: ES256 and Ed25519 verify real signatures', () => {
  // ES256
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = ec.publicKey.export({ format: 'jwk' });
  const cose = { 1: 2, 3: -7, '-1': 1, '-2': Buffer.from(jwk.x, 'base64url'), '-3': Buffer.from(jwk.y, 'base64url') };
  const msg = Buffer.from('the board says hello');
  const sig = crypto.sign('sha256', msg, ec.privateKey);
  const es = W.coseKey(cose);
  assert.ok(es.hash === 'sha256');
  assert.ok(crypto.verify('sha256', msg, es.key, sig), 'ES256 round trip');
  assert.equal(W.coseKey(cose).jwk.kty, 'EC');
  // Ed25519 — the raw-key SPKI wrapper path
  const ed = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(ed.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const edSig = crypto.sign(null, msg, ed.privateKey);
  const edd = W.coseKey({ 1: 1, 3: -8, '-1': 6, '-2': raw });
  assert.ok(edd.hash === null);
  assert.ok(crypto.verify(null, msg, edd.key, edSig), 'Ed25519 round trip through the wrapper');
  assert.throws(() => W.coseKey({ 1: 0, 3: -7 }), /unsupported key alg/, 'unknown kty refused');
});

// ---- fake authenticator over HTTP ----
let KP, credentialId, regChallenge;
const origin = () => base;
const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin: origin() })).toString('base64url');
const rpIdHash = () => W.sha256(Buffer.from('127.0.0.1'));   // host without port
const attestationAuthData = () => {
  const cose = { 1: 2, 3: -7, '-1': 1, '-2': Buffer.from(KP.publicKey.export({ format: 'jwk' }).x, 'base64url'), '-3': Buffer.from(KP.publicKey.export({ format: 'jwk' }).y, 'base64url') };
  return Buffer.concat([rpIdHash(), Buffer.from([0x45]), Buffer.from([0, 0, 0, 0]),   // UP|UV|AT flags, count 0
    Buffer.alloc(16), Buffer.from([0, 32]), credentialId, enc(cose)]);
};
const assertionAuthData = count => Buffer.concat([rpIdHash(), Buffer.from([0x01]), Buffer.from([0, 0, 0, 0].map((_, i) => count >>> ((3 - i) * 8)))]);

test('a fake authenticator can enroll a passkey', async () => {
  KP = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  credentialId = crypto.randomBytes(32);
  const beg = await api('GET', '/api/admin/webauthn/begin-registration');
  assert.equal(beg.status, 200);
  assert.equal(beg.body.rpId, '127.0.0.1');
  regChallenge = beg.body.challenge;
  const att = enc({ fmt: 'none', attStmt: {}, authData: attestationAuthData() });
  const fin = await api('POST', '/api/admin/webauthn/finish-registration', {
    challenge: regChallenge, name: 'Test key',
    response: { clientDataJSON: clientData('webauthn.create', regChallenge), attestationObject: att.toString('base64url') },
  });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.ok(fin.body.id >= 1);
  const list = await api('GET', '/api/admin/webauthn/credentials');
  assert.equal(list.body.keys.length, 1);
  assert.equal(list.body.keys[0].name, 'Test key');
  assert.ok(!('public_key' in list.body.keys[0]), 'the private half of nothing is stored — the key material never comes back');
});
test('the same authenticator can sign in and get a session', async () => {
  const beg = await fetch(base + '/api/admin/webauthn/begin-authentication').then(r => r.json());
  const ad = assertionAuthData(1);
  const cd = clientData('webauthn.get', beg.challenge);
  const sig = crypto.sign('sha256', Buffer.concat([ad, W.sha256(Buffer.from(cd, 'base64url'))]), KP.privateKey);
  const r = await fetch(base + '/api/admin/webauthn/finish-authentication', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: beg.challenge, id: credentialId.toString('base64url'), response: { clientDataJSON: cd, authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url') } }) });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.ok(/bd_session=/.test(sc || ''), 'a passkey mints the same session cookie');
  const use = await fetch(base + '/api/admin/config', { headers: { cookie: sc.split(';')[0] } });
  assert.equal(use.status, 200, 'the minted session works');
});
test('passkey failures are all audited and all closed', async () => {
  const attempts = [];
  // wrong signature
  let beg = await fetch(base + '/api/admin/webauthn/begin-authentication').then(r => r.json());
  let cd = clientData('webauthn.get', beg.challenge);
  let other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  attempts.push(['wrong key', await fetch(base + '/api/admin/webauthn/finish-authentication', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: beg.challenge, id: credentialId.toString('base64url'), response: { clientDataJSON: cd, authenticatorData: assertionAuthData(2).toString('base64url'), signature: crypto.sign('sha256', Buffer.concat([assertionAuthData(2), W.sha256(Buffer.from(cd, 'base64url'))]), other.privateKey).toString('base64url') } }) }).then(r => r.status)]);
  // reused challenge (single use)
  attempts.push(['reused challenge', await fetch(base + '/api/admin/webauthn/finish-authentication', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: beg.challenge, id: credentialId.toString('base64url'), response: { clientDataJSON: cd, authenticatorData: assertionAuthData(3).toString('base64url'), signature: crypto.sign('sha256', Buffer.concat([assertionAuthData(3), W.sha256(Buffer.from(cd, 'base64url'))]), KP.privateKey).toString('base64url') } }) }).then(r => r.status)]);
  // wrong origin
  beg = await fetch(base + '/api/admin/webauthn/begin-authentication').then(r => r.json());
  cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: beg.challenge, origin: 'https://evil.example' })).toString('base64url');
  attempts.push(['wrong origin', await fetch(base + '/api/admin/webauthn/finish-authentication', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: beg.challenge, id: credentialId.toString('base64url'), response: { clientDataJSON: cd, authenticatorData: assertionAuthData(4).toString('base64url'), signature: crypto.sign('sha256', Buffer.concat([assertionAuthData(4), W.sha256(Buffer.from(cd, 'base64url'))]), KP.privateKey).toString('base64url') } }) }).then(r => r.status)]);
  // counter rollback (cloned authenticator): went 1 → 5 earlier, so 5 again is backwards... use a fresh assert then lower
  beg = await fetch(base + '/api/admin/webauthn/begin-authentication').then(r => r.json());
  cd = clientData('webauthn.get', beg.challenge);
  attempts.push(['counter rollback', await fetch(base + '/api/admin/webauthn/finish-authentication', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: beg.challenge, id: credentialId.toString('base64url'), response: { clientDataJSON: cd, authenticatorData: Buffer.concat([rpIdHash(), Buffer.from([0x01]), Buffer.from([0, 0, 0, 0])]).toString('base64url'), signature: crypto.sign('sha256', Buffer.concat([Buffer.concat([rpIdHash(), Buffer.from([0x01]), Buffer.from([0, 0, 0, 0])]), W.sha256(Buffer.from(cd, 'base64url'))]), KP.privateKey).toString('base64url') } }) }).then(r => r.status)]);
  assert.equal(attempts[0][1], 401, 'wrong key refused');
  assert.equal(attempts[1][1], 400, 'reused challenge refused');
  assert.equal(attempts[2][1], 400, 'wrong origin refused');
  assert.equal(attempts[3][1], 401, 'counter rollback refused');
  const sec = await api('GET', '/api/admin/security');
  const kinds = sec.body.events.map(e => e.kind);
  assert.ok(kinds.includes('webauthn_fail'), 'failures are on the record');
});
test('credential management: rename via list, revoke, then the passkey path closes', async () => {
  const list = await api('GET', '/api/admin/webauthn/credentials');
  const id = list.body.keys[0].id;
  assert.equal((await api('DELETE', `/api/admin/webauthn/credentials/${id}`)).status, 200);
  assert.equal((await fetch(base + '/api/admin/webauthn/begin-authentication')).status, 404, 'no active passkeys → begin-authentication says so');
  assert.equal((await api('DELETE', `/api/admin/webauthn/credentials/${id}`)).status, 404, 'double revoke is a 404');
  // re-enroll with a strict counter and walk the clone-detection rules
  const KP2 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const cid2 = crypto.randomBytes(32);
  const j = KP2.publicKey.export({ format: 'jwk' });
  const cose = { 1: 2, 3: -7, '-1': 1, '-2': Buffer.from(j.x, 'base64url'), '-3': Buffer.from(j.y, 'base64url') };
  const ad = Buffer.concat([rpIdHash(), Buffer.from([0x45]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, 32]), cid2, enc(cose)]);
  const begR = await api('GET', '/api/admin/webauthn/begin-registration');
  const finR = await api('POST', '/api/admin/webauthn/finish-registration', { challenge: begR.body.challenge, name: 'counter key', response: { clientDataJSON: clientData('webauthn.create', begR.body.challenge), attestationObject: enc({ fmt: 'none', attStmt: {}, authData: ad }).toString('base64url') } });
  assert.equal(finR.status, 200, 're-enroll');
  const assertOnce = async (cnt) => {
    const beg = await fetch(base + '/api/admin/webauthn/begin-authentication').then(r => r.json());
    const cd = clientData('webauthn.get', beg.challenge);
    const adA = assertionAuthData(cnt);
    return fetch(base + '/api/admin/webauthn/finish-authentication', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge: beg.challenge, id: cid2.toString('base64url'), response: { clientDataJSON: cd, authenticatorData: adA.toString('base64url'), signature: crypto.sign('sha256', Buffer.concat([adA, W.sha256(Buffer.from(cd, 'base64url'))]), KP2.privateKey).toString('base64url') } }) }).then(r => r.status);
  };
  assert.equal(await assertOnce(5), 200, 'count 5 accepted');
  assert.equal(await assertOnce(5), 401, 'repeated count refused (clone)');
  assert.equal(await assertOnce(3), 401, 'backwards count refused');
  assert.equal(await assertOnce(6), 200, 'forward count accepted');
});
