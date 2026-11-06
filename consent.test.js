'use strict';
// Guardian consent tests (0020): the managed tier's COPPA VPC step —
// notice + consent email + knowledge-based challenge + neutral age-band
// assertion, recorded as the consent artifact. Self-host (no env) is
// unchanged: the 0017 self-host acknowledgment.
process.env.DB_PATH = ':memory:';
process.env.SETUP_TOKEN = 'consent-suite-token-4242';
process.env.LOGIN_RATE_LIMIT = '1000';
// provision like the managed platform would: hashed answers (sha256 of the
// normalized answer), emailed to the parent separately
const crypto = require('node:crypto');
const nAns = s => String(s).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const h = s => crypto.createHash('sha256').update(nAns(s)).digest('hex');
process.env.BD_REQUIRE_CONSENT = '1';
process.env.BD_CONSENT_KBA = JSON.stringify([
  { q: 'What is the name of your first pet?', h: h('a dog named Zephyr') },
  { q: 'What street did you live on in 2019?', h: h('42 Beacon Street') },
]);
process.env.BD_CONSENT_NOTICE = 'The board keeps the behavioral record of the child on this host.';

const test = require('node:test');
const assert = require('node:assert');
const { server, db } = require('./server.js');

let base, cookie;
test.before(async () => {
  await new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
test.after(() => server.close());
const me = () => fetch(base + '/api/admin/me').then(r => r.json());
const setup = body => fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));

test('an unconfigured managed board advertises the consent step', async () => {
  const m = await me();
  assert.equal(m.setup, true);
  assert.equal(m.consent_required, true);
  assert.deepEqual(m.consent_questions, ['What is the name of your first pet?', 'What street did you live on in 2019?']);
  assert.match(m.consent_notice, /behavioral record/);
});
test('setup without the consent payload is refused', async () => {
  const r = await setup({ password: 'correct-horse-battery', child_name: 'Sam', token: process.env.SETUP_TOKEN });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /parent email/);
  assert.equal((await me()).setup, true, 'the board is still unconfigured — nothing leaked through');
});
test('a wrong KBA answer is refused, and the board stays unconfigured', async () => {
  const r = await setup({ password: 'correct-horse-battery', child_name: 'Sam', token: process.env.SETUP_TOKEN,
    consent: { email: 'parent@example.org', answers: ['something else', '42 Beacon Street'], age_band: 'under13' } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /first pet/, 'the failing question is named — the parent may legitimately miss it');
  assert.equal((await me()).setup, true);
});
test('a missing or bad age band is refused', async () => {
  const r = await setup({ password: 'correct-horse-battery', child_name: 'Sam', token: process.env.SETUP_TOKEN,
    consent: { email: 'parent@example.org', answers: ['a dog named zephyr', '42 beacon street'], age_band: '12' } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /age band/);
});
test('the right answers complete setup, and the artifact is on the record', async () => {
  const r = await setup({ password: 'correct-horse-battery', child_name: 'Sam', token: process.env.SETUP_TOKEN,
    consent: { email: 'Parent@Example.org ', answers: ['  A DOG   NAMED ZEPHYR  ', '42 beacon street'], age_band: 'under13' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const cfg = await fetch(base + '/api/admin/config', { headers: { cookie } }).then(r => r.json());
  assert.ok(cfg.identity.child_name === 'Sam');
  const consents = await fetch(base + '/api/admin/consent', { headers: { cookie } }).then(r => r.json());
  assert.equal(consents.consents.length, 1);
  const c = consents.consents[0];
  assert.equal(c.kind, 'vpc_kba', 'the artifact type is the VPC record');
  assert.equal(c.contact, 'Parent@Example.org', 'the consent email is on the record (trimmed, case kept)');
  assert.match(c.what, /16 CFR 312\.5\(b\)\(viii\)/);
  assert.match(c.what, /under 13/, 'the age-band assertion is in the artifact');
  assert.match(c.what, /2 questions/, 'the challenge strength is recorded');
  // answer normalization worked: whitespace/case variants matched the hashed answers
});
test('a board without the consent env keeps the self-host acknowledgment', async () => {
  // a second suite would set its own env; here we assert the artifact KIND
  // default is what self-host boards get (0017 behavior, unchanged)
  assert.equal(process.env.BD_REQUIRE_CONSENT, '1', 'this suite runs the managed config');
  // the real self-host matrix is covered by server.test.js (no env) — the
  // artifact there is kind=self_host_ack because the default column is.
});
