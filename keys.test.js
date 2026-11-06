'use strict';
// Key re-reveal + rotation (0021) and per-board webhook settings (0022).
// The key tests use a real on-disk encrypted store; the webhook tests run
// against :memory: with a local receiver.
process.env.DB_PATH = `/tmp/bd-keys-${process.pid}/board.db`;
process.env.BD_ENCRYPTION = 'on';
process.env.BD_PASSPHRASE = 'original-stable-passphrase';
process.env.SETUP_TOKEN = 'keys-suite-token-3131';
process.env.LOGIN_RATE_LIMIT = '1000';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { server, store, db } = require('./server.js');

let base, cookie;
const dir = path.dirname(process.env.DB_PATH);
const blob = path.join(dir, 'board.enc');
const setup = async () => {
  const r = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', child_name: 'Sam', token: process.env.SETUP_TOKEN }) });
  return r.headers.get('set-cookie').split(';')[0];
};
test.before(async () => {
  await new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  cookie = await setup();
});
test.after(() => server.close());
const api = async (method, p, body, hdr = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie, ...hdr }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('0021 re-reveal: the console can show the passphrase the host generated', async () => {
  const k = await api('GET', '/api/admin/key');
  assert.equal(k.status, 200);
  assert.equal(k.body.encrypted, true);
  assert.equal(k.body.passphrase, 'original-stable-passphrase', 'the managed.md promise: the key is re-revealable');
  assert.equal(k.body.generated_by_host, true);
  assert.match(k.body.rotate_notice, /lost passphrase/);
});
test('0021 rotation: the blob re-encrypts in place and the old key stops working', async () => {
  await api('POST', '/api/admin/abc', { behaviors: ['x'], note: 'survives rotation' });
  store.persist();
  const before = fs.readFileSync(blob);
  const short = await api('POST', '/api/admin/key/rotate', { passphrase: 'short' });
  assert.equal(short.status, 400, 'too-short key refused');
  const same = await api('POST', '/api/admin/key/rotate', { passphrase: 'original-stable-passphrase' });
  assert.equal(same.status, 400, 'rotating to the same key refused');
  const r = await api('POST', '/api/admin/key/rotate', { passphrase: 'rotated-passphrase-v2' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.passphrase, 'rotated-passphrase-v2');
  assert.ok(!fs.readFileSync(blob).equals(before), 'the blob changed');
  // the new key opens it; the old key does not
  const data = fs.readFileSync(blob);
  const W = require('./store.js');
  assert.ok(W.decryptBlob(data, 'rotated-passphrase-v2').length > 0, 'the new key opens the blob');
  assert.throws(() => W.decryptBlob(data, 'original-stable-passphrase'), 'the old key is dead');
  // and the running store still reads/writes through the new key
  const k2 = await api('GET', '/api/admin/key');
  assert.equal(k2.body.passphrase, 'rotated-passphrase-v2');
  const abc = await api('GET', '/api/admin/abc');
  assert.ok(abc.body.events.some(e => e.note === 'survives rotation'), 'the data survived the rotation');
});
test('0022 webhook: the family setting is stored, used, and takes precedence over env', async () => {
  // a receiver for the test
  const hits = [];
  const rx = http.createServer((rq, rs) => { let b = ''; rq.on('data', c => b += c); rq.on('end', () => { hits.push(JSON.parse(b || '{}')); rs.end(); }); });
  await new Promise(r => rx.listen(0, '127.0.0.1', r));
  process.env.BD_WEBHOOK_URL = 'http://127.0.0.1:9/never-called';
  // bad URL refused
  assert.equal((await api('PUT', '/api/admin/webhook', { url: 'not a url' })).status, 400);
  assert.equal((await api('PUT', '/api/admin/webhook', { url: 'ftp://x' })).status, 400);
  // set the family's webhook and fire a request
  await api('PUT', '/api/admin/profile', { id: 'communication' });
  await api('PUT', '/api/admin/webhook', { url: `http://127.0.0.1:${rx.address().port}/hook` });
  const choices = (await api('GET', '/api/admin/config')).body.choices.map(c => c.label);
  await api('POST', '/api/admin/kiosk-devices', { label: 'Voice kiosk' });
  const tk = (await api('GET', '/api/admin/kiosk-devices')).body;
  const tokenHash = await fetch(base + '/api/today', { headers: {} }).catch(() => null);
  // use the device token created above
  const dev = (await api('GET', '/api/admin/kiosk-devices')).body.devices[0];
  const t = await fetch(base + '/api/today', { headers: { 'x-kiosk-token': (await (async () => {
    // create a fresh device to get a raw token: re-create since the raw token is shown once
    const made = await api('POST', '/api/admin/kiosk-devices', { label: 'K2' });
    return made.body.token;
  })() ) } }).then(r => r.json());
  await fetch(base + '/api/today/request', { method: 'POST', headers: { 'content-type': 'application/json', 'x-kiosk-token': (await api('POST', '/api/admin/kiosk-devices', { label: 'K3' })).body.token }, body: JSON.stringify({ label: choices[0] }) });
  await new Promise(r => setTimeout(r, 300));
  assert.ok(hits.length >= 1, 'the family webhook fired');
  assert.equal(hits[hits.length - 1].kind, 'request');
  // clear it → the env fallback would fire to a dead port (never reached); assert cleared state
  const cleared = await api('PUT', '/api/admin/webhook', { url: '' });
  assert.equal(cleared.body.cleared, true);
  const st = await api('GET', '/api/admin/webhook');
  assert.equal(st.body.configured, false);
  assert.equal(st.body.from_env, true, 'the env fallback is visible to the family');
  await new Promise(r => rx.close(r));
  delete process.env.BD_WEBHOOK_URL;
});
