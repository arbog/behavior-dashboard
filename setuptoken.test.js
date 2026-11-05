'use strict';
// The bootstrap token on a genuinely fresh board: with no SETUP_TOKEN env the
// server prints one to its boot log exactly once, and setup is refused
// without it. This suite must NOT set SETUP_TOKEN — that is the point.
process.env.DB_PATH = ':memory:';
delete process.env.SETUP_TOKEN;

const test = require('node:test');
const assert = require('node:assert');

// Capture the boot log while the module initializes.
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };
const { server, db } = require('./server.js');
console.log = origLog;

const bootToken = (() => {
  const line = logs.find(l => l.startsWith('setup token:'));
  return line ? line.slice('setup token:'.length).trim() : '';
})();

let base;
test.before(async () => {
  await new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
test.after(() => server.close());

const setup = body => fetch(base + '/api/admin/setup', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('a fresh board prints a 64-hex setup token once and only once', () => {
  assert.match(bootToken, /^[0-9a-f]{64}$/, `expected a 64-hex boot token, got ${JSON.stringify(bootToken)}`);
  assert.equal(logs.filter(l => l.startsWith('setup token:')).length, 1, 'printed exactly once');
});

test('the unconfigured state probe advertises that a token is required', async () => {
  const me = await (await fetch(base + '/api/admin/me')).json();
  assert.deepEqual([me.setup, me.setup_token], [true, true]);
});

test('setup without the token is refused, with a bad token is refused', async () => {
  const none = await setup({ password: 'correct-horse-battery' });
  assert.equal(none.status, 403);
  const bad = await setup({ password: 'correct-horse-battery', token: 'f'.repeat(64) });
  assert.equal(bad.status, 403);
  // still unconfigured, still offering setup
  const me = await (await fetch(base + '/api/admin/me')).json();
  assert.equal(me.setup, true);
});

test('the right token completes setup exactly once and is consumed', async () => {
  const ok = await setup({ password: 'correct-horse-battery', token: bootToken });
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.get('set-cookie'), 'setup logs the parent in');
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='setup_token_hash'").get(), undefined, 'token hash consumed');
  const again = await setup({ password: 'another-strong-pw', token: bootToken });
  assert.equal(again.status, 409, 'a board cannot be claimed twice');
});

test('the failed attempts are on the audit record', () => {
  const events = db.prepare("SELECT kind, ok, detail FROM security_events WHERE kind='setup_fail'").all();
  assert.ok(events.length >= 2, `expected setup_fail events, got ${events.length}`);
  assert.ok(events.every(e => e.ok === 0));
});
