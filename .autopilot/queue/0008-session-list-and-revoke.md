---
id: 0008
title: Session visibility and revocation ("signed-in devices")
plan_ref: H
provider: evobox
sandbox: node
risk: medium
max_iterations: 3
estimated_minutes: 40
---

## Goal

A parent who sees a login event from an unfamiliar IP cannot see or kill a
live session — only change the password (which nukes their own open consoles
too). Add first-class session management:

- `sessions` gains `last_seen TEXT` (updated on authed use, throttled to one
  write per 60s per session in-memory, like the kiosk note) and the response
  shape needs a stable short id: expose `substr(token_hash, 0, 12)` as `sid`
  (never the full hash).
- New endpoints (admin-gated like the rest, audited):
  - `GET /api/admin/sessions` → `{ sessions: [ { sid, created_at, expires_at, last_seen, current } ] }`
    (mark the caller's own session `current: true`; include it so the UI can
    say "this device").
  - `DELETE /api/admin/sessions` → revoke all sessions except the caller's
    (audit `session_revoke_all`); returns `{ ok: true, revoked: n }`.
  - `DELETE /api/admin/sessions/:sid` → revoke one by its 12-char sid,
    matching on the sid prefix of the stored hash (audit
    `session_revoke`); 404 on unknown sid.
- The existing logout stays (it is "revoke me").
- UI: a "Signed-in devices" card in `public/admin.html` Settings, above the
  security log: one row per session (created, last seen, "this device" tag),
  a "Sign out this device" button and a "Sign out everything else" button.
- Make the login rate limit env-tunable for tests and big households:
  `LOGIN_RATE_LIMIT` (default 10) — the lockout threshold (5) stays fixed.
- Docs: `docs/security-model.md` gains a "Sessions" subsection (visibility,
  revocation, last_seen semantics).

## Files in scope

- server.js
- server.test.js
- public/admin.html
- docs/security-model.md

## Files explicitly out of scope

- hardening.test.js, dbperms.test.js, compose.yaml, Dockerfile, .github/*

## Acceptance

```sh
node --test
grep -q "api/admin/sessions" public/admin.html
grep -q "Signed-in devices" public/admin.html
node -e "
process.env.DB_PATH = ':memory:';
process.env.SETUP_TOKEN = 'a'.repeat(64);
const { server } = require('./server.js');
server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const cookieOf = async (r) => { const c = r.headers.get('set-cookie'); return c ? c.split(';')[0] : null; };
  const setup = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', token: 'a'.repeat(64) }) });
  const a = await cookieOf(setup);
  const lb = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery' }) });
  const b = await cookieOf(lb);
  if (!a || !b) throw new Error('expected two session cookies');
  const list = await (await fetch(base + '/api/admin/sessions', { headers: { cookie: a } })).json();
  if (list.sessions.length !== 2) throw new Error('expected 2 sessions, got ' + list.sessions.length);
  if (!list.sessions.every(s => s.sid && s.sid.length === 12)) throw new Error('sid must be 12 chars');
  const target = list.sessions.find(s => !s.current).sid;
  const del = await fetch(base + '/api/admin/sessions/' + target, { method: 'DELETE', headers: { cookie: a } });
  if (del.status !== 200) throw new Error('revoke-one must be 200, got ' + del.status);
  const after = await fetch(base + '/api/admin/config', { headers: { cookie: b } });
  if (after.status !== 401) throw new Error('revoked session must be dead, got ' + after.status);
  const still = await fetch(base + '/api/admin/config', { headers: { cookie: a } });
  if (still.status !== 200) throw new Error('caller session must survive, got ' + still.status);
  const all = await fetch(base + '/api/admin/sessions', { method: 'DELETE', headers: { cookie: a } });
  const allBody = await all.json();
  if (all.status !== 200 || allBody.revoked < 1) throw new Error('revoke-all must revoke the other, got ' + JSON.stringify(allBody));
  server.close();
  console.log('sessions-ok');
});
" | grep -q sessions-ok
```

## Stop and ask if

- revoking "all except caller" should also clear the in-memory `lockouts`
  (a locked-out attacker who then sees sessions wiped might be confused) —
  default to NOT touching lockouts, ask if you think otherwise
- the `last_seen` throttled write interacts badly with the in-memory `:memory:`
  test DB across the two test files (it shouldn't — each file has its own
  process)

## Notes for the agent

- The existing `server.test.js` suite already does several logins; with
  `LOGIN_RATE_LIMIT` default 10 the suite must still pass — set
  `process.env.LOGIN_RATE_LIMIT = 1000` at the top of that file if needed
  (that is the point of the knob).
- Keep the audit events out of the `admin_write` catch-all (they have their
  own kinds) — the acceptance for 0007/0008-era tests asserts on kinds.
