---
id: 0006
title: Enforce 0600 on the SQLite data file at boot
plan_ref: H
provider: evobox
sandbox: node
risk: low
max_iterations: 2
estimated_minutes: 15
---

## Goal

A bare-Node start with a permissive umask leaves a world-readable file that
is a child's behavioral record. On boot, after the data directory is created
and before the DB is opened, `fs.chmodSync` the directory to `0700` and the
DB file (plus `-wal`/`-shm` if present) to `0600`, best-effort: wrap in
try/catch, log a warning on failure, never crash the boot (Windows has
different permission semantics and a failure there should not brick the app).
Skip chmod entirely when `DB_PATH === ':memory:'`. Do not chmod on every
request — boot only.

## Files in scope

- server.js
- dbperms.test.js (new)

## Files explicitly out of scope

- server.test.js, hardening.test.js, public/*, docs/*, Dockerfile

## Acceptance

```sh
node --test
node -e "
process.env.DB_PATH = '/tmp/bd-perm-test-' + Date.now() + '/board.db';
try { require('node:fs').rmSync(process.env.DB_PATH, { recursive: true }); } catch {}
require('./server.js');
const st = require('node:fs').statSync(process.env.DB_PATH);
const mode = st.mode & 0o777;
if (mode !== 0o600) throw new Error('expected 0600, got ' + mode.toString(8));
const dst = require('node:fs').statSync(require('node:path').dirname(process.env.DB_PATH));
const dmode = dst.mode & 0o777;
if (dmode !== 0o700) throw new Error('expected dir 0700, got ' + dmode.toString(8));
require('node:fs').rmSync(require('node:path').dirname(process.env.DB_PATH), { recursive: true });
console.log('db-perms-ok');
" | grep -q db-perms-ok
```

## Stop and ask if

- chmod must also apply when the DB file already exists with a different
  owner (EPERM/EOPNOTSUPP on some filesystems) — decide whether to warn-and-
  continue or fail-closed, and prefer warn-and-continue

## Notes for the agent

- `dbperms.test.js` must set `process.env.DB_PATH` to a real temp path
  BEFORE requiring server.js, and clean up after itself. The other test
  files use `:memory:` and must not be affected.
