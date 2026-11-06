'use strict';
// OAuth sign-in tests (0023): a stub identity provider (Google and Apple
// dialects) that signs real ID tokens with a generated RSA key — the whole
// link + sign-in flow over HTTP, plus the refusal matrix.
process.env.DB_PATH = ':memory:';
process.env.SETUP_TOKEN = 'oauth-suite-setup-token-777';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.OAUTH_RATE_LIMIT = '1000';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');

let base, cookie;
// ---- the stub provider: authorize is faked by the test calling the
// callback directly with a token it signed itself ----
const KP = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'stub-key-1';
const jwks = { keys: [{ kty: 'RSA', kid: KID, n: KP.publicKey.export({ format: 'jwk' }).n, e: KP.publicKey.export({ format: 'jwk' }).e, alg: 'RS256', use: 'sig' }] };
const idToken = (over = {}) => {
  const header = { alg: 'RS256', kid: KID };
  const claims = { iss: 'https://accounts.google.com', aud: 'stub-client-id', exp: Math.floor(Date.now() / 1000) + 300, email: 'parent@example.com', sub: '12345', ...over };
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signed = enc(header) + '.' + enc(claims);
  return signed + '.' + crypto.sign('sha256', Buffer.from(signed), KP.privateKey).toString('base64url');
};
let tokenServer;
let TOKEN_URL;
test.before(async () => {
  tokenServer = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', c => b += c);
    rq.on('end', () => { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ id_token: idToken() })); });
  });
  await new Promise(r => tokenServer.listen(0, '127.0.0.1', r));
  TOKEN_URL = `http://127.0.0.1:${tokenServer.address().port}/token`;
  // the board talks to the stub for token exchange and JWKS
  process.env.BD_OAUTH_GOOGLE_CLIENT_ID = 'stub-client-id';
  process.env.BD_OAUTH_GOOGLE_CLIENT_SECRET = 'stub-secret';
  process.env.BD_OAUTH_GOOGLE_AUTH_URL = 'http://127.0.0.1:1/authorize';   // never actually followed (tests call begin for the URL shape)
  process.env.BD_OAUTH_GOOGLE_TOKEN_URL = TOKEN_URL;
  process.env.BD_OAUTH_GOOGLE_JWKS_URL = TOKEN_URL.replace('/token', '/jwks');
  process.env.BD_OAUTH_APPLE_CLIENT_ID = 'stub-apple-id';
  process.env.BD_OAUTH_APPLE_CLIENT_SECRET = 'stub-apple-secret';
  process.env.BD_OAUTH_APPLE_AUTH_URL = 'http://127.0.0.1:1/authorize';
  process.env.BD_OAUTH_APPLE_JWKS_URL = TOKEN_URL.replace('/token', '/jwks');
  const { server } = require('./server.js');
  await new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  const s = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', child_name: 'Sam', token: process.env.SETUP_TOKEN }) });
  cookie = s.headers.get('set-cookie').split(';')[0];
});
test.after(() => { tokenServer?.close(); require('./server.js').server.close(); });
// the stub serves its own JWKS on the same port — swap the handler per phase
let jwksMode = 'jwks';
(async () => {
  // rewrite the handler target once the test server exists
  tokenServer.removeAllListeners('request');
  tokenServer.on('request', (rq, rs) => {
    if (rq.url.startsWith('/jwks') && jwksMode === 'jwks') { rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify(jwks)); }
    rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ id_token: idToken() }));
  });
})();
const begin = async (provider, hdr = {}) => {
  const r = await fetch(`${base}/api/admin/oauth/begin?provider=${provider}`, { headers: { cookie, ...hdr } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('configured providers are discoverable; unknown ones are not', async () => {
  const pv = await fetch(base + '/api/admin/oauth/providers').then(r => r.json());
  assert.deepEqual(pv.providers.sort(), ['apple', 'google']);
  assert.equal((await begin('github')).status, 404);
});
test('begin hands back the provider authorize URL with a single-use state', async () => {
  const g = await begin('google');
  assert.equal(g.status, 200);
  assert.ok(g.body.url.startsWith('http://127.0.0.1:1/authorize'));
  assert.ok(g.body.url.includes('client_id=stub-client-id'));
  assert.ok(g.body.state, 'state issued');
  const again = await begin('apple');
  assert.ok(again.body.url.includes('response_mode=form_post'), 'Apple uses form_post');
});
test('the full Google flow: link from the console, then sign in with it', async () => {
  const g = await begin('google');
  const state = g.body.state;
  // unauthenticated callback with a fresh (unlinked) identity → refused
  const refused = await fetch(`${base}/api/admin/oauth/google/callback?code=c&state=${state}`, { redirect: 'manual' });
  assert.equal(refused.status, 302);
  assert.match(refused.headers.get('location'), /not%20linked/, 'an unlinked identity can never sign in — no account is created by OAuth');
  // now link it from the signed-in console
  const g2 = await begin('google');
  const linked = await fetch(`${base}/api/admin/oauth/google/callback?code=c&state=${g2.body.state}`, { redirect: 'manual', headers: { cookie } });
  assert.equal(linked.status, 302);
  assert.match(linked.headers.get('location'), /linked/, 'the console session links the identity');
  // sign in without a session: a real session cookie comes back
  const g3 = await begin('google');
  const signin = await fetch(`${base}/api/admin/oauth/google/callback?code=c&state=${g3.body.state}`, { redirect: 'manual' });
  assert.equal(signin.status, 200);
  const sc = signin.headers.get('set-cookie');
  assert.ok(/bd_session=/.test(sc || ''), 'OAuth mints the same session cookie');
  const me = await fetch(base + '/api/admin/config', { headers: { cookie: sc.split(';')[0] } });
  assert.equal(me.status, 200, 'the minted session works');
  // the state was single use
  const g4 = await begin('google');
  const reused = await fetch(`${base}/api/admin/oauth/google/callback?code=c&state=${g3.body.state}`, { redirect: 'manual' });
  assert.match(reused.headers.get('location'), /expired/, 'a reused state is dead');
});
test('the refusal matrix: wrong audience, expired, alg-none, tampered', async () => {
  const badToken = over => {
    const saved = idToken;
    return idToken(over);
  };
  // wrong audience
  const g1 = await begin('google');
  tokenServer.removeAllListeners('request');
  tokenServer.on('request', (rq, rs) => {
    if (rq.url.startsWith('/jwks')) { rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify(jwks)); }
    rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ id_token: idToken({ aud: 'someone-else' }) }));
  });
  const r1 = await fetch(`${base}/api/admin/oauth/google/callback?code=c&state=${g1.body.state}`, { redirect: 'manual' });
  assert.match(r1.headers.get('location'), /not%20for%20this%20board/, 'a token for another client is refused');
  // expired
  tokenServer.removeAllListeners('request');
  tokenServer.on('request', (rq, rs) => {
    if (rq.url.startsWith('/jwks')) { rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify(jwks)); }
    rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ id_token: idToken({ exp: Math.floor(Date.now() / 1000) - 60 }) }));
  });
  const g2 = await begin('google');
  const r2 = await fetch(`${base}/api/admin/oauth/google/callback?code=c&state=${g2.body.state}`, { redirect: 'manual' });
  assert.match(r2.headers.get('location'), /expired/, 'an expired token is refused');
  // alg none
  tokenServer.removeAllListeners('request');
  tokenServer.on('request', (rq, rs) => {
    if (rq.url.startsWith('/jwks')) { rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify(jwks)); }
    const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const tok = enc({ alg: 'none', kid: KID }) + '.' + enc({ iss: 'https://accounts.google.com', aud: 'stub-client-id', exp: 9999999999, email: 'x@y.z', sub: '12345' }) + '.';
    rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ id_token: tok }));
  });
  const g3 = await begin('google');
  const r3 = await fetch(`${base}/api/admin/oauth/google/callback?code=c&state=${g3.body.state}`, { redirect: 'manual' });
  assert.match(r3.headers.get('location'), /refused%20algorithm/, 'alg=none is refused outright');
  // restore the good handler
  tokenServer.removeAllListeners('request');
  tokenServer.on('request', (rq, rs) => {
    if (rq.url.startsWith('/jwks')) { rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify(jwks)); }
    rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ id_token: idToken() }));
  });
});
test('the Apple dialect: form_post of the finished id_token', async () => {
  const a = await begin('apple');
  const tok = idToken({ iss: 'https://appleid.apple.com', aud: 'stub-apple-id' });
  const body = new URLSearchParams({ state: a.body.state, id_token: tok });
  const linked = await fetch(`${base}/api/admin/oauth/apple/callback`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.equal(linked.status, 302);
  assert.match(linked.headers.get('location'), /linked/, 'Apple linking works through the urlencoded body');
  // and Apple sign-in mints a session without any cookie
  const a2 = await begin('apple');
  const signin = await fetch(`${base}/api/admin/oauth/apple/callback`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state: a2.body.state, id_token: idToken({ iss: 'https://appleid.apple.com', aud: 'stub-apple-id' }) }) });
  assert.equal(signin.status, 200);
  assert.ok(/bd_session=/.test(signin.headers.get('set-cookie') || ''), 'Apple sign-in works');
});
test('unlinking removes the path in', async () => {
  const list = await fetch(base + '/api/admin/oauth/identities', { headers: { cookie } }).then(r => r.json());
  assert.ok(list.identities.length >= 2);
  const google = list.identities.find(i => i.provider === 'google');
  const del = await fetch(`${base}/api/admin/oauth/identities/${google.id}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(del.status, 200);
  const g = await begin('google');
  const out = await fetch(`${base}/api/admin/oauth/google/callback?code=c&state=${g.body.state}`, { redirect: 'manual' });
  assert.match(out.headers.get('location'), /not%20linked/, 'unlinked → sign-in refused again');
});
