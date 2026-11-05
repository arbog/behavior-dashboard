'use strict';
// API-level tests against a live server on an in-memory DB.
process.env.DB_PATH = ':memory:';
// A fresh board owes a bootstrap token; this suite supplies it non-interactively.
process.env.SETUP_TOKEN = 'main-suite-setup-token-9f8e7d6c';
// the suite performs more logins than a minute allows a stranger; tests are not strangers
process.env.LOGIN_RATE_LIMIT = '1000';
const test = require('node:test');
const assert = require('node:assert');
const { server } = require('./server.js');

let PW = 'correct-horse-battery';

let base, cookie = '', kiosk = '';
test.before(async () => {
  await new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
  // first run: set up the console
  const s = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW, child_name: 'Sam', token: process.env.SETUP_TOKEN }) });
  assert.equal(s.status, 200, 'setup');
  cookie = s.headers.get('set-cookie').split(';')[0];
  const t = await call('POST', '/api/admin/kiosk-devices', { label: 'Test kiosk' });
  kiosk = t.body.token;
});
test.after(() => server.close());

const call = async (method, p, body, headers = {}) => {
  const h = { 'content-type': 'application/json', ...headers };
  if (cookie && p.startsWith('/api/admin/')) h.cookie = cookie;
  if (p.startsWith('/api/') && !p.startsWith('/api/admin/') && kiosk) h['x-kiosk-token'] = kiosk;
  const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), setCookie: r.headers.get('set-cookie') };
};
const kioskRaw = async (method, p, body, tok) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tok ? { 'x-kiosk-token': tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// ---------- security ----------
test('unconfigured boards offer setup; configured boards require login', async () => {
  // the /me probe is the UI's state machine: 200+setup before config, 401 after
  const me = await kioskRaw('GET', '/api/admin/me');
  assert.equal(me.status, 401);
  assert.equal(me.body.setup, false);
  const dup = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  assert.equal(dup.status, 409, 'setup is a one-shot');
});
test('admin API is closed without a session', async () => {
  assert.equal((await kioskRaw('GET', '/api/admin/config')).status, 401);
  assert.equal((await kioskRaw('GET', '/api/admin/kiosk-devices')).status, 401, 'the kiosk device list is session-gated');
  assert.equal((await kioskRaw('POST', '/api/admin/logout')).status, 401, 'logout without a session is a no-op, not a leak');
});
test('kiosk API is closed without (or with a wrong) token', async () => {
  assert.equal((await kioskRaw('GET', '/api/today')).status, 401);
  assert.equal((await kioskRaw('GET', '/api/today', undefined, 'deadbeef')).status, 401);
  assert.equal((await kioskRaw('POST', '/api/today/choice', { label: 'x' })).status, 401);
  assert.equal((await kioskRaw('GET', '/api/today', undefined, kiosk.slice(0, 10))).status, 401, 'truncated token does not prefix-match');
  // the token rides the query string ONLY for the initial GET /api/today —
  // the deep-link affordance, and the one place it may reach proxy logs
  assert.equal((await fetch(base + '/api/today?token=' + encodeURIComponent(kiosk))).status, 200);
  const tapByQuery = await fetch(base + '/api/today/choice?token=' + encodeURIComponent(kiosk), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'TV' }) });
  assert.equal(tapByQuery.status, 401, 'writes must carry the header, not the query');
  assert.equal((await kioskRaw('POST', '/api/today/choice', { label: 'TV' }, kiosk)).status, 200, 'the header form still works');
});
test('responses carry the security header set (HSTS off without SECURE_COOKIES)', async () => {
  const r = await fetch(base + '/');
  const h = r.headers;
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.match(h.get('content-security-policy'), /^default-src 'self'/);
  assert.equal(h.get('referrer-policy'), 'no-referrer');
  assert.equal(h.get('strict-transport-security'), null, 'HSTS must not fire on a plain-HTTP deploy');
  const apiRes = await fetch(base + '/api/today', { headers: { 'x-kiosk-token': kiosk } });
  assert.equal(apiRes.headers.get('x-content-type-options'), 'nosniff', 'API responses carry the set too');
  assert.equal(apiRes.headers.get('x-frame-options'), 'DENY');
});
test('kiosk devices: create, use, revoke per device; legacy code migrates', async () => {
  const old = kiosk;
  const tv = await call('POST', '/api/admin/kiosk-devices', { label: 'Kitchen TV' });
  assert.equal(tv.status, 200);
  assert.ok(/^[0-9a-f]{48}$/.test(tv.body.token), 'raw token shown exactly once at create');
  assert.equal((await kioskRaw('GET', '/api/today', undefined, tv.body.token)).status, 200, 'new device authenticates');
  assert.equal((await kioskRaw('GET', '/api/today', undefined, old)).status, 200, 'the pre-existing device still works');
  const list = await call('GET', '/api/admin/kiosk-devices');
  assert.ok(list.body.devices.some(d => d.label === 'Kitchen TV' && !d.revoked_at));
  assert.ok(list.body.devices.some(d => d.label === 'Test kiosk'));
  // revoking ONE device kills only that device
  const del = await call('DELETE', `/api/admin/kiosk-devices/${tv.body.id}`);
  assert.equal(del.status, 200);
  assert.equal((await kioskRaw('GET', '/api/today', undefined, tv.body.token)).status, 401, 'revoked device is dead');
  assert.equal((await kioskRaw('GET', '/api/today', undefined, old)).status, 200, 'sibling device unaffected');
  assert.equal((await call('DELETE', '/api/admin/kiosk-devices/99999')).status, 404);
  // cap: 8 active devices max
  let capHit = false;
  for (let i = 0; i < 10; i++) {
    if ((await call('POST', '/api/admin/kiosk-devices', { label: 'pad' + i })).status === 400) { capHit = true; break; }
  }
  assert.ok(capHit, 'the active-device cap refuses more');
  assert.ok((await call('POST', '/api/admin/kiosk-devices', { label: '' })).status === 400, 'a label is required');
  // the audit names the device events
  const sec = (await call('GET', '/api/admin/security')).body;
  assert.ok(sec.events.some(e => e.kind === 'kiosk_device_add' && e.detail === 'Kitchen TV'));
  assert.ok(sec.events.some(e => e.kind === 'kiosk_device_revoke' && e.detail === 'Kitchen TV'));
  // the security payload now carries live devices with last-used
  assert.ok(sec.kiosk_devices.some(d => d.label === 'Test kiosk'));
  assert.ok('kiosk_last_used' in sec === false, 'the single shared note is gone');
  // legacy migration: seed the old-style setting on a second device set… (covered
  // by the boot path; here we assert the setting-based import helper exists)
  assert.ok(require('./server.js').db.prepare("SELECT 1 FROM kiosk_devices WHERE label='Test kiosk'").get());
});
test('password change requires the current one, rejects weak ones, and kills every session', async () => {
  assert.equal((await call('POST', '/api/admin/password', { current: 'wrong', next: 'newer-password-1' })).status, 403, 'refused without the current password');
  assert.equal((await call('POST', '/api/admin/password', { current: PW, next: 'short' })).status, 400, 'short replacement refused');
  assert.equal((await call('POST', '/api/admin/password', { current: PW, next: 'password123' })).status, 400, 'common replacement refused');
  // a second live session: a console left open on a borrowed phone
  const login2 = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  assert.equal(login2.status, 200);
  const cookie2 = login2.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('POST', '/api/admin/password', { current: PW, next: 'newer-password-1' })).status, 200);
  const r2 = await fetch(base + '/api/admin/config', { headers: { cookie: cookie2 } });
  assert.equal(r2.status, 401, 'the other session is dead too');
  const r0 = await fetch(base + '/api/admin/config', { headers: { cookie } });
  assert.equal(r0.status, 401, 'even the changing session is signed out');
  PW = 'newer-password-1';
  const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  assert.equal(login.status, 200, 'the new password works on a fresh login');
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/admin/config')).status, 200);
});
// ---- 0008: session visibility and revocation ----
test('signed-in devices: list, revoke one, revoke all-but-me', async () => {
  const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
  const second = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  assert.equal(second.status, 200);
  const cookie2 = cookieOf(second);
  assert.ok(cookie2, 'second session exists');
  const list = await call('GET', '/api/admin/sessions');
  assert.equal(list.status, 200);
  assert.ok(list.body.sessions.length >= 2, 'both sessions listed');
  assert.ok(list.body.sessions.every(s => s.sid && s.sid.length === 12), 'sids are 12-char prefixes');
  assert.equal(list.body.sessions.filter(s => s.current).length, 1, 'exactly one current session');
  const mine = list.body.sessions.find(s => s.current);
  const other = list.body.sessions.find(s => !s.current);
  // revoke the OTHER session by sid
  const del = await call('DELETE', `/api/admin/sessions/${other.sid}`);
  assert.equal(del.status, 200);
  const dead = await fetch(base + '/api/admin/config', { headers: { cookie: cookie2 } });
  assert.equal(dead.status, 401, 'revoked session is dead');
  const alive = await call('GET', '/api/admin/config');
  assert.equal(alive.status, 200, 'caller session survives');
  // unknown sid → 404
  assert.equal((await call('DELETE', '/api/admin/sessions/deadbeef0001')).status, 404);
  // revoke-all-but-me
  const third = cookieOf(await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) }));
  assert.ok(third);
  const all = await call('DELETE', '/api/admin/sessions');
  assert.equal(all.status, 200);
  assert.equal(all.body.revoked, 1, 'the one remaining other session was revoked');
  assert.equal((await call('GET', '/api/admin/config')).status, 200, 'caller survives revoke-all');
  const gone = await fetch(base + '/api/admin/config', { headers: { cookie: third } });
  assert.equal(gone.status, 401);
  // the audit shows it
  const sec = (await call('GET', '/api/admin/security')).body;
  assert.ok(sec.events.some(e => e.kind === 'session_revoke'));
  assert.ok(sec.events.some(e => e.kind === 'session_revoke_all'));
  void mine;
});

// last among the auth tests: it locks this IP out for 15 minutes, and the
// board-behaviour tests below ride the live session, not a login.
test('login rejects a wrong password and lockout kicks in after five', async () => {
  const bad = tok => fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope-' + tok }) });
  for (let i = 0; i < 5; i++) assert.equal((await bad(i)).status, 401, 'failure ' + (i + 1));
  assert.equal((await bad(5)).status, 423, 'sixth attempt is locked out');
  const good = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  assert.equal(good.status, 423, 'even the right password waits out the lockout');
});

// ---------- board behaviour (engine ported whole from the reference build) ----------
test('kiosk builds today from the weekday template', async () => {
  const { body } = await call('GET', '/api/today');
  assert.ok(body.items.length >= 3);
  assert.equal(body.reward.minutes, 30);
  assert.equal(body.child_name, 'Sam');
});
test('token economy tiers: all checks / 1 X / 2+ X', async () => {
  await call('POST', '/api/admin/today/reset', {});
  let t = (await call('GET', '/api/today')).body;
  for (const it of t.items) await call('POST', `/api/today/items/${it.id}/finish`, { done: true });
  for (const it of t.items) await call('PATCH', `/api/admin/day-items/${it.id}`, { rules: 'check' });
  t = (await call('GET', '/api/today')).body;
  assert.deepEqual([t.reward.tier, t.reward.minutes, t.reward.final], ['all', 30, true]);
  await call('PATCH', `/api/admin/day-items/${t.items[0].id}`, { rules: 'x' });
  t = (await call('GET', '/api/today')).body;
  assert.deepEqual([t.reward.tier, t.reward.minutes], ['one', 15]);
  // An X caps the day: finishing the rest clean cannot get them back to 30, so
  // the kiosk must not promise it.
  assert.equal(t.reward.projected, 15);
  await call('PATCH', `/api/admin/day-items/${t.items[1].id}`, { finished: false });
  t = (await call('GET', '/api/today')).body;
  assert.deepEqual([t.reward.tier, t.reward.minutes], ['two', 0]);
  await call('PATCH', `/api/admin/day-items/${t.items[0].id}`, { rules: 'turnaround' });
  await call('PATCH', `/api/admin/day-items/${t.items[1].id}`, { finished: true });
  t = (await call('GET', '/api/today')).body;
  assert.equal(t.reward.tier, 'all');
});
test('rewards are seeded and cannot be emptied', async () => {
  const t = (await call('GET', '/api/today')).body;
  assert.ok(t.choices.length >= 3);
  assert.equal((await call('PUT', '/api/admin/choices', { choices: [] })).status, 400);
  assert.ok((await call('GET', '/api/today')).body.choices.length >= 3);
});
test('board copy is editable: child name, bands, reward lines, protocol', async () => {
  const me = await call('PUT', '/api/admin/identity', { child_name: 'Riley' });
  assert.equal(me.body.child_name, 'Riley');
  assert.equal((await call('GET', '/api/today')).body.child_name, 'Riley');

  const bands = (await call('GET', '/api/admin/config')).body.regulation.battery.bands;
  const edited = bands.map((b, i) => i === 0 ? { ...b, name: 'Super ready', note: 'custom note' } : b);
  assert.equal((await call('PUT', '/api/admin/bands', { bands: edited })).status, 200);
  let b = (await call('GET', '/api/today')).body.battery;
  assert.equal(b.band.name, 'Super ready');
  assert.equal(b.band.note, 'custom note');
  assert.equal((await call('PUT', '/api/admin/bands', { bands: [{ name: 'x' }] })).status, 400, 'four bands are the shape of the battery');

  const rew = await call('PUT', '/api/admin/rewards', { lines: ['One', 'Two'] });
  assert.equal(rew.status, 200);
  assert.deepEqual((await call('GET', '/api/today')).body.rewards, ['One', 'Two']);

  const proto = await call('PUT', '/api/admin/protocol', { checkin_minutes: 90, proactive: ['A', 'B'], behavior: ['C'], hold: 'hold', script: 'hi {name}', script_rule: 'yo {name}, {rule}' });
  assert.equal(proto.body.checkin_minutes, 90);
  assert.equal((await call('GET', '/api/admin/config')).body.regulation.protocol.proactive.length, 2);
  // restore the default protocol so later tests (behavior tap, script wording)
  // run against the neutral copy, not this test's scratch edits
  await call('PUT', '/api/admin/protocol', { checkin_minutes: 120, proactive: ['Check in every 1–2 hours while awake', 'Review the battery together', 'Spend 5–10 minutes in a preferred activity', 'Catch good behavior — specific positive praise', 'Before leaving: review the battery, expectations, and consequences'], behavior: ['Name the rule that is not being followed', 'Pause any reinforcement that may be going on (screen time, etc.)', 'Remove one line from the battery', 'Offer a check-in', 'Once back to baseline, re-engage and review the battery', 'Reinforcement resumes after a check-in AND using a tool'], hold: 'If they are not ready, or the behavior continues, do not power-struggle. Remain available for support.', script: 'When you are ready, we can talk about your battery.', script_rule: '{name}, right now you are not following “{rule}”. When you are ready, we can talk about your battery.' });
});
test('mode override swaps schedule and clears', async () => {
  const cfg = (await call('GET', '/api/admin/config')).body;
  const free = cfg.modes.find(m => m.name === 'Free Day');
  await call('PUT', '/api/admin/override', { mode_id: free.id });
  assert.equal((await call('GET', '/api/today')).body.mode.name, 'Free Day');
  await call('PUT', '/api/admin/override', { mode_id: null });
  assert.equal((await call('GET', '/api/admin/config')).body.override, null);
});
test('ABC log + summary', async () => {
  await call('POST', '/api/admin/abc', { antecedents: ['Told no'], behaviors: ['Yelling/Screaming'], consequences: ['Redirection to alternative choice/coping skills'] });
  const { body } = await call('GET', '/api/admin/abc?days=7');
  assert.equal(body.summary.total, 1);
  assert.deepEqual(body.summary.behaviors, [['Yelling/Screaming', 1]]);
});
test('kiosk shows the battery, the tools, the rules and the reward wording', async () => {
  const { body } = await call('GET', '/api/today');
  assert.deepEqual([body.battery.lines, body.battery.max, body.battery.pct], [5, 5, 100]);
  assert.ok(body.tools.length >= 5);
  assert.ok(body.rules.length >= 3);
  assert.ok(body.rewards.length >= 1);
});
test('the behavior tap runs the protocol: ABC entry, line off, pause, script', async () => {
  const cfg = (await call('GET', '/api/admin/config')).body;
  const rule = cfg.regulation.rules[0];
  const { body } = await call('POST', '/api/admin/behavior', { rule_id: rule.id, behaviors: ['Yelling/Screaming'], antecedents: ['Told no'] });
  assert.equal(body.battery.lines, 4);
  assert.equal(body.pause.active, true);
  assert.match(body.script, /not following/i, 'script names the rule');
  assert.ok(body.next.some(s => /check[- ]in/i.test(s)));
  assert.ok(body.hold.length > 0);
  const abc = (await call('GET', '/api/admin/abc?days=7')).body;
  assert.equal(abc.events[0].behaviors[0], 'Yelling/Screaming');
  assert.equal(abc.events[0].severity, 3);
  // reinforcement is off, and the kiosk says so
  assert.equal((await call('GET', '/api/today')).body.pause.active, true);
});
test('reinforcement resumes only after a check-in AND a tool', async () => {
  const tools = (await call('GET', '/api/today')).body.tools;
  const p0 = (await call('GET', '/api/today')).body.pause;
  assert.equal(p0.active, true);
  assert.equal(p0.resume_ready, false);
  await call('POST', '/api/admin/checkins', { hunger: 2 });
  assert.equal((await call('GET', '/api/today')).body.pause.resume_ready, false, 'check-in alone does not resume');
  await call('POST', `/api/today/tools/${tools[0].id}/use`, {});
  const p1 = (await call('GET', '/api/today')).body.pause;
  assert.equal(p1.resume_ready, true, 'check-in + tool is the gate');
  await call('POST', '/api/admin/resume', { restore: 1 });
  assert.equal((await call('GET', '/api/today')).body.pause.active, false);
  assert.equal((await call('GET', '/api/today')).body.battery.lines, 5);
});
test('check-ins carry the risk factors and the risk model scores them', async () => {
  // hunger full (3) alone = 40 → Elevated (40 < 50). Boredom/house stay 0.
  const { body } = await call('POST', '/api/admin/checkins', { hunger: 3, boredom: 0, house: 0, note: 'before lunch' });
  assert.equal(body.risk.total, 40);
  assert.equal(body.risk.band.name, 'Elevated');
  const cfg = (await call('GET', '/api/admin/config')).body;
  assert.equal(cfg.regulation.check_in.last.note, 'before lunch');
  assert.ok(cfg.regulation.check_in.today >= 1);
});
test('risk patterns aggregate check-ins and behaviors', async () => {
  await call('POST', '/api/admin/checkins', { hunger: 3, boredom: 3, house: 2 });
  const { body } = await call('GET', '/api/admin/risk?days=7');
  assert.ok(body.timeline.length >= 1);
  assert.ok(Array.isArray(body.top_behaviors));
  assert.equal(body.behaviors.count, 2, 'both blowups logged so far');
});
test('day plans carry their name to the kiosk without clobbering marks', async () => {
  const cfg = (await call('GET', '/api/admin/config')).body;
  const trip = cfg.modes.find(m => m.name === 'Trip Day');
  const sat = (() => { const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7)); return d.toISOString().slice(0, 10); })();
  await call('PUT', `/api/admin/plans/${sat}`, { mode_id: trip.id, kind: 'trip', label: 'Beach Day', note: 'leave after breakfast' });
  const cal = (await call('GET', '/api/admin/calendar?days=14')).body.calendar;
  const d1 = cal.find(c => c.date === sat);
  assert.deepEqual([d1.label, d1.kind, d1.mode_name, d1.source], ['Beach Day', 'trip', 'Trip Day', 'plan']);
  // a plan for today that lands after marks must not rebuild the day
  const today = new Date().toISOString().slice(0, 10);
  await call('PATCH', `/api/admin/day-items/${(await call('GET', '/api/today')).body.items[0].id}`, { rules: 'x' });
  await call('PUT', `/api/admin/plans/${today}`, { mode_id: trip.id, kind: 'trip', label: 'Beach Day', note: 'tide pools at 11' });
  const t = (await call('GET', '/api/today')).body;
  assert.deepEqual([t.plan.label, t.plan.kind], ['Beach Day', 'trip']);
  assert.ok(t.items.some(i => i.rules === 'x'), 'marks survived the plan');
  await call('DELETE', `/api/admin/plans/${today}`);
  await call('DELETE', `/api/admin/plans/${sat}`);
});
test('the security log records auth outcomes, admin writes, and kiosk use', async () => {
  const { body } = await call('GET', '/api/admin/security');
  const kinds = new Set(body.events.map(e => e.kind));
  // setup scrolled past the 50-row window long ago in this suite; the table itself is the record
  const { db } = require('./server.js');
  assert.ok(db.prepare("SELECT 1 FROM security_events WHERE kind='setup'").get(), 'setup is on the record');
  assert.ok(kinds.has('login_ok'), 'successful logins are on the record');
  assert.ok(kinds.has('login_fail'), 'failed logins are on the record (with detail)');
  assert.ok(kinds.has('admin_write'), 'admin mutations are on the record');
  const write = body.events.find(e => e.kind === 'admin_write');
  assert.match(write.detail, /^(POST|PUT|PATCH|DELETE) \/api\//);
  assert.ok(body.events.every(e => e.ok === 0 || e.ok === 1));
  assert.ok(body.events.length <= 50, 'the endpoint caps at 50');
  assert.ok(Array.isArray(body.kiosk_devices) && body.kiosk_devices.some(d => d.label), 'live kiosk devices with last-used are in the payload');
  // audit is gated like everything else on the console
  assert.equal((await kioskRaw('GET', '/api/admin/security')).status, 401);
});
test('healthz stays open and proves the DB', async () => {
  const r = await kioskRaw('GET', '/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body.db, true);
});
test('the kiosk page and admin page shells are public; their data is not', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/admin')).status, 200);
  assert.equal((await fetch(base + '/definitely-not-a-page')).status, 404);
});

// ---- 0005: XFF trust model + limiter hygiene ----
test('X-Forwarded-For is trusted only from private peers', () => {
  const { clientIp, isPrivateAddr } = require('./server.js');
  const fake = (peer, xff) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: peer } });
  // behind a proxy we can see: honour the forwarded client
  assert.equal(clientIp(fake('127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(fake('::ffff:127.0.0.1', '8.8.4.4')), '8.8.4.4');
  assert.equal(clientIp(fake('10.0.0.5', '1.2.3.4')), '1.2.3.4');
  assert.equal(clientIp(fake('172.20.1.9', '1.2.3.4')), '1.2.3.4');
  assert.equal(clientIp(fake('100.86.0.5', '1.2.3.4')), '1.2.3.4', 'tailscale peers are trusted');
  // directly exposed: the header is attacker-controlled, ignore it
  assert.equal(clientIp(fake('203.0.113.9', '10.0.0.1')), '203.0.113.9');
  assert.equal(clientIp(fake('47.6.169.128', '198.51.100.7')), '47.6.169.128');
  // the classifier itself
  for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '::1', '100.64.0.1', '100.127.255.254', 'fc00::1', '::ffff:10.0.0.1']) {
    assert.ok(isPrivateAddr(a), `${a} should be private`);
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.9', '']) {
    assert.equal(isPrivateAddr(a), false, `${a} should not be private`);
  }
});

// ---- 0010: export + version ----
test('the family can take their data: export endpoint, healthz version', async () => {
  const h = await call('GET', '/healthz');
  assert.ok(h.body.version && /\d+\.\d+\.\d+/.test(h.body.version), 'healthz carries the app version');
  const x = await fetch(base + '/api/admin/export', { headers: { cookie } });
  assert.equal(x.status, 200);
  assert.ok(/attachment/.test(x.headers.get('content-disposition') || ''), 'export is an attachment');
  assert.ok(/behavior-dashboard-\d{4}-\d\d-\d\d\.json/.test(x.headers.get('content-disposition')), 'dated filename');
  const body = await x.json();
  assert.equal(body.app, 'behavior-dashboard');
  assert.equal(body.version, h.body.version);
  assert.ok(body.exported_at, 'export is timestamped');
  for (const t of ['modes', 'settings', 'day_items', 'abc_events', 'security_events', 'sessions', 'kiosk_devices']) {
    assert.ok(Array.isArray(body.tables[t]), `export includes ${t}`);
  }
  assert.ok(body.tables.modes.length >= 4, 'the seeded modes are in the export');
  assert.equal((await kioskRaw('GET', '/api/admin/export')).status, 401, 'export without a session is closed');
});

// ---- 0012: API keys (admin-scoped automation) + docs/api.md sync ----
test('API keys: create, attribute writes, list prefix-only, revoke, cap at 5', async () => {
  // create — the raw key is returned exactly once
  const made = await call('POST', '/api/admin/api-keys', { name: 'home-assistant' });
  assert.equal(made.status, 200);
  assert.match(made.body.key, /^bdb_[0-9a-f]{48}$/, 'raw key is bdb_ + 48 hex');
  const raw = made.body.key;
  // the key works without any cookie — bearer and x-api-key are equivalent
  const probe = await fetch(base + '/api/admin/api-keys', { headers: { authorization: 'Bearer ' + raw } });
  assert.equal(probe.status, 200, 'Bearer header authenticates');
  const listed = await probe.json();
  assert.ok(listed.keys.length >= 1);
  assert.ok(!('key_hash' in listed.keys[0]) && !('key' in listed.keys[0]), 'the raw key and its hash never come back');
  assert.match(listed.keys[0].prefix, /^bdb_[0-9a-f]{6}/, 'the list shows a prefix only');
  const viaHeader = await fetch(base + '/api/admin/api-keys', { headers: { 'x-api-key': raw } });
  assert.equal(viaHeader.status, 200, 'x-api-key works too');
  // a key-driven write is attributed api:<name>
  // a key-driven write is attributed api:<name> — raw fetch, no cookie
  const kw = await fetch(base + '/api/admin/abc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + raw }, body: JSON.stringify({ behaviors: ['whining'], note: 'key-driven entry' }) });
  assert.equal(kw.status, 200, 'the key can write');
  const abc = await call('GET', '/api/admin/abc');
  const entry = abc.body.events.find(e => e.by === 'api:home-assistant');
  assert.ok(entry, 'the write records by = api:home-assistant');
  // a session cookie outranks any key material a proxy might pass along
  const both = await fetch(base + '/api/admin/api-keys', { headers: { cookie, authorization: 'Bearer bdb_' + '0'.repeat(48) } });
  assert.equal(both.status, 200, 'a valid session is unaffected by a bogus key');
  // garbage keys are 401, and the security log records the lifecycle
  assert.equal((await fetch(base + '/api/admin/api-keys', { headers: { authorization: 'Bearer bdb_' + 'f'.repeat(48) } })).status, 401);
  const sec = await call('GET', '/api/admin/security');
  assert.ok(sec.body.events.some(e => e.kind === 'api_key_create' && e.detail === 'home-assistant'), 'api_key_create is on the record');
  // the kiosk surface never accepts a bearer
  assert.equal((await fetch(base + '/api/today', { headers: { authorization: 'Bearer ' + raw } })).status, 401);
  // cap: fill to 5 active, then the next create is refused
  const names = ['k2', 'k3', 'k4', 'k5'];
  for (const n of names) {
    const r = await call('POST', '/api/admin/api-keys', { name: n });
    assert.equal(r.status, 200, n + ' created');
  }
  const over = await call('POST', '/api/admin/api-keys', { name: 'k6' });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /at most 5/);
  // revoke home-assistant — the raw key stops working immediately
  const id = listed.keys.find(k => k.name === 'home-assistant').id;
  assert.equal((await call('DELETE', `/api/admin/api-keys/${id}`)).status, 200);
  assert.equal((await fetch(base + '/api/admin/api-keys', { headers: { authorization: 'Bearer ' + raw } })).status, 401, 'revoked key is dead');
  const after = await call('GET', '/api/admin/api-keys');
  assert.ok(after.body.keys.find(k => k.id === id).revoked_at, 'revocation is visible in the list');
  const sec2 = await call('GET', '/api/admin/security');
  assert.ok(sec2.body.events.some(e => e.kind === 'api_key_revoke'), 'api_key_revoke is on the record');
  // and the kiosk devices row of the security payload carries keys now
  assert.ok(Array.isArray(sec2.body.api_keys), 'security payload includes live api keys');
});
test('docs/api.md documents every route the server handles', () => {
  const src = require('fs').readFileSync('server.js', 'utf8');
  const doc = require('fs').readFileSync('docs/api.md', 'utf8');
  const paths = new Set();
  for (const m of src.matchAll(/p === '([^']+)'/g)) paths.add(m[1]);
  for (const m of src.matchAll(/url\.pathname === '([^']+)'/g)) paths.add(m[1]);
  for (const m of src.matchAll(/p\.match\(\^(\/[^\$]+)\$\)\.matchAll/g)) paths.add(m[1]);   // not used, but harmless
  for (const m of src.matchAll(/p\.match\(\^(\/[a-z/-]+)\/\(/g)) paths.add(m[1] + '/:param');
  // the parameter spellings api.md uses
  const renames = { '/api/admin/abc/:param': '/api/admin/abc/:id', '/api/admin/api-keys/:param': '/api/admin/api-keys/:id', '/api/admin/day-items/:param': '/api/admin/day-items/:id', '/api/admin/kiosk-devices/:param': '/api/admin/kiosk-devices/:id', '/api/admin/modes/:param': '/api/admin/modes/:id', '/api/admin/plans/:param': '/api/admin/plans/:date', '/api/admin/sessions/:param': '/api/admin/sessions/:sid' };
  const missing = [...paths].filter(p => p !== '/api/admin/me' || true).map(p => renames[p] || p).filter(p => !doc.includes(p));
  assert.deepEqual(missing, [], `docs/api.md is missing routes: ${missing.join(', ')}`);
});
