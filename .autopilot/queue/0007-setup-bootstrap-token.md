---
id: 0007
title: One-time setup bootstrap token (closes the first-writer-wins admin race)
plan_ref: H
provider: evobox
sandbox: node
risk: medium
max_iterations: 3
estimated_minutes: 40
---

## Goal

Today a fresh install's `POST /api/admin/setup` is first-writer-wins: anyone
who reaches the URL before the parent creates the password becomes the admin
(rate limit + weak-list are not enough). Fix with a one-time bootstrap token:

- On boot, if there is no `admin_hash` yet: if env `SETUP_TOKEN` is set, use
  it (log once: `setup token provided via SETUP_TOKEN env`); else generate a
  32-byte random hex token, store its SHA-256 in settings as
  `setup_token_hash`, and print the raw token to stdout exactly once, in a
  line starting `setup token:` (the deploy's log/dashboard is how the parent
  gets it).
- `POST /api/admin/setup` requires `body.token` matching `setup_token_hash`
  (constant-time compare; timing-equalize like the login path when unset).
  A wrong/missing token → 403 `{ error: 'setup token required or wrong' }`
  and `logEvent('setup_fail', ip, 'bad token', false)`. A correct token
  completes setup exactly once: on success DELETE `setup_token_hash` so the
  token cannot be reused (and `logEvent('setup', ip)` as today).
- If `ADMIN_PASSWORD` env configured the board at boot, no token exists —
  setup is permanently 409 as today.
- The unauthenticated `/api/admin/me` state probe gains `setup_token: true`
  when a token is outstanding (the UI uses it to show the token field; it
  reveals existence, not value — that is intended).
- UI: the setup card in `public/admin.html` gets a "Setup token (from the
  server log)" field, sent as `token`.
- Docs: `docs/self-hosting.md` (how to get the token: server log line, or
  `SETUP_TOKEN` env for PaaS) and `docs/security-model.md` (the race is
  closed; token is single-use).

## Files in scope

- server.js
- server.test.js
- public/admin.html
- docs/self-hosting.md
- docs/security-model.md

## Files explicitly out of scope

- hardening.test.js, dbperms.test.js, Dockerfile, compose.yaml,
  .github/*, docs/roadmap.md, docs/self-service.md

## Acceptance

```sh
node --test
# fresh server WITHOUT SETUP_TOKEN: setup without token is refused,
# with the logged token it succeeds exactly once, token cannot be reused:
node -e "
process.env.DB_PATH = '/tmp/bd-setup-' + Date.now() + '.db';
try { require('node:fs').rmSync(process.env.DB_PATH, { force: true }); } catch {}
const logs = [];
const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
const { server, db } = require('./server.js');
console.log = orig;
const tok = (logs.find(l => l.startsWith('setup token:')) || '').slice('setup token:'.length).trim();
if (!/^[0-9a-f]{64}$/.test(tok)) throw new Error('expected a 64-hex setup token on the boot log, got: ' + JSON.stringify(tok));
server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (b) => fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const r0 = await post({ password: 'correct-horse-battery' });
  if (r0.status !== 403) throw new Error('setup without token must be 403, got ' + r0.status);
  const r1 = await post({ password: 'correct-horse-battery', token: 'wrong'.repeat(8) });
  if (r1.status !== 403) throw new Error('setup with bad token must be 403, got ' + r1.status);
  const r2 = await post({ password: 'correct-horse-battery', token: tok });
  if (r2.status !== 200) throw new Error('setup with good token must be 200, got ' + r2.status);
  const r3 = await post({ password: 'another-strong-pw', token: tok });
  if (r3.status !== 409) throw new Error('second setup must be 409, got ' + r3.status);
  if (db.prepare(\"SELECT value FROM settings WHERE key='setup_token_hash'\").get()) throw new Error('token hash must be consumed');
  server.close();
  require('node:fs').rmSync(process.env.DB_PATH, { force: true });
  console.log('setup-token-ok');
});
" | grep -q setup-token-ok
# SETUP_TOKEN env path:
node -e "
process.env.DB_PATH = '/tmp/bd-setup2-' + Date.now() + '.db';
process.env.SETUP_TOKEN = 'envtoken-' + 'a1b2c3d4e5f6'.repeat(3);
try { require('node:fs').rmSync(process.env.DB_PATH, { force: true }); } catch {}
const { server } = require('./server.js');
server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', token: process.env.SETUP_TOKEN }) });
  if (r.status !== 200) throw new Error('env setup token must work, got ' + r.status);
  server.close();
  require('node:fs').rmSync(process.env.DB_PATH, { force: true });
  console.log('setup-env-ok');
});
" | grep -q setup-env-ok
grep -q "setup_token" docs/self-hosting.md
grep -q "setup" docs/security-model.md
```

## Stop and ask if

- the existing `server.test.js` setup test (it calls /api/admin/setup with no
  token in `test.before`) needs redesigning to fetch the token from the
  boot log or from `db` settings — that is expected, and fine, but if the
  suite architecture makes that awkward (e.g. the server is shared across
  files) say so rather than weakening the token check
- printing the token to stdout conflicts with an existing log format the
  compose/Docker docs rely on

## Notes for the agent

- `server.test.js` `test.before` currently does a bare setup — update it to
  read the token out of the DB (`settings.setup_token_hash` is a hash, so
  instead capture the stdout line, or set `process.env.SETUP_TOKEN` at the
  top of that file — the env seam is the cleanest for the existing suite).
- Keep the weak-password and timing-equalizer behavior intact (tests for it
  exist).
