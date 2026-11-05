'use strict';
// The TLS-posture half of the hardening pass: run as its own process because
// SECURE_COOKIES is read at module load (node --test gives each file one).
process.env.DB_PATH = ':memory:';
process.env.SECURE_COOKIES = '1';
const test = require('node:test');
const assert = require('node:assert');
const { server } = require('./server.js');

let base;
test.before(async () => {
  await new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
test.after(() => server.close());

test('setup rejects a common password even when it is 8+ characters', async () => {
  const weak = await fetch(base + '/api/admin/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'password123' }),
  });
  assert.equal(weak.status, 400);
  assert.match((await weak.json()).error, /too common/);
});

test('behind TLS: HSTS is sent and the session cookie carries Secure', async () => {
  const page = await fetch(base + '/');
  assert.match(page.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.match(page.headers.get('strict-transport-security'), /includeSubDomains/);

  const setup = await fetch(base + '/api/admin/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'secure-tls-pass-9x' }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie');
  assert.match(cookie, /Secure/i, 'session cookie must be Secure behind TLS');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});
