---
id: 0018
title: Encryption at rest (whole-DB blob, per the research design)
plan_ref: C
provider: evobox
sandbox: node
risk: high
max_iterations: 5
estimated_minutes: 60
thinking: high
---

## Goal

Deliver the VALUES.md promise that the data is "encrypted in the database and
reliably retrievable" for self-hosters too: a stolen disk must not yield a
child's behavioral record. **Read `.autopilot/research/0003/output.md` (or
`docs/research/encryption.md`) FIRST — its "Recommendation" and "Design"
sections are the binding spec (file layout, boot sequence, KDF, re-encrypt
cadence, consistency model, backup procedure, recovery story). If that file
is missing, STOP and ask. If the research recommended Option B (field-level)
or D (filesystem-only) instead of A (whole-DB blob), implement THAT and
adjust this task's acceptance to match the recommended design's promises —
but flag the divergence in your hand-back note.**

Expected shape (if the research recommended the whole-DB blob):
- At rest, `/data` holds an **encrypted blob** (e.g.
  `board.enc`), not a readable SQLite file. Layout: a versioned header
  (magic + format version + KDF params + salt + nonce + auth tag) wrapping
  an AES-256-GCM (or the research's chosen AEAD) ciphertext of the
  SQLite-file bytes.
- Boot: passphrase supplied (env `BD_PASSPHRASE` for headless/PaaS, or — on
  a first run without it — interactive via a tiny stdin prompt when
  `process.stdout.isTTY`), KDF (scrypt, params per research), decrypt to a
  chmod-0600 temp file in the data dir (or tmpfs where available), open
  `node:sqlite` on it.
- Shutdown (`SIGTERM`/`SIGINT`/clean exit): flush SQLite, re-encrypt,
  atomically replace the blob (write temp + rename), unlink plaintext.
- Periodic re-encrypt on a write cadence (per research, e.g. every N
  committed writes or M seconds), so a crash loses at most the window —
  document exactly how much.
- **The blob IS the backup**: `docs/self-hosting.md` backup/restore becomes
  "copy `board.enc`; restore = put it back and supply the passphrase."
- **Key-loss is explicit, not implicit**: the UI (and a boot log line) says
  in plain words that the passphrase is the only key and there is no
  recovery if it is lost; the research's recovery-code recommendation, if
  any, is implemented as specified.
- Migration: an existing plaintext `board.db` on first encrypted boot is
  encrypted (with the supplied passphrase) and the plaintext removed,
  logged. A `--check` or healthz field reflects encrypted mode.

Keep the zero-dep rule (node:crypto only). Do NOT change the app's data
model, auth, or API in this task — encryption is a storage-layer concern
underneath the existing `db` handle.

## Files in scope

- server.js
- dbperms.test.js (rename/extend into the encryption test, or a new
  encryptedb.test.js — your call, but server.test.js's `:memory:` path must
  keep working untouched, since in-memory needs no encryption)
- docs/self-hosting.md (backup/restore + passphrase + migration)
- docs/security-model.md (at-rest encryption subsection + key-loss)
- compose.yaml (document the `BD_PASSPHRASE` env; do not set a default)

## Files explicitly out of scope

- server.test.js, hardening.test.js, webauthn.test.js, public/* (no UI in
  this task beyond what a passphrase prompt forces), Dockerfile, .github/*

## Acceptance

```sh
node --test
node -e "
process.env.BD_PASSPHRASE = 'test-passphrase-123';
const dir = '/tmp/bd-enc-' + Date.now();
process.env.DB_PATH = dir + '/board.db';
try { require('node:fs').rmSync(dir, { recursive: true, force: true }); } catch {}
require('./server.js');
const { db } = module.exports;
db.prepare('CREATE TABLE IF NOT EXISTS probe(x)').run();
db.prepare('INSERT INTO probe VALUES (42)').run();
const fs = require('node:fs');
// after a clean close the data dir must hold ciphertext, not readable sqlite:
process.emit('SIGINT', process);
setTimeout(async () => {
  const files = fs.readdirSync(dir);
  const blob = files.find(f => f.endsWith('.enc'));
  if (!blob) throw new Error('expected an encrypted blob in ' + dir + ', got ' + files);
  const head = fs.readFileSync(dir + '/' + blob).slice(0, 64).toString('latin1');
  if (head.includes('SQLite format 3')) throw new Error('blob is readable plaintext sqlite');
  // wrong passphrase must fail closed, not produce a corrupt-open:
  process.env.BD_PASSPHRASE = 'wrong-passphrase';
  // (a fresh require in a child process is cleaner; assert here that the
  //  auth tag is checked by attempting a decrypt with the wrong key and
  //  expecting a throw — use the exported decrypt helper if the task
  //  implementation exposes one, else skip to the child-process form):
  console.log('enc-blob-ok');
  process.exit(0);
}, 400);
" | grep -q enc-blob-ok
# wrong-passphrase must fail closed (child process, fresh module):
node -e "
process.env.BD_PASSPHRASE = 'wrong-passphrase';
const dir = process.argv[1];
process.env.DB_PATH = dir + '/board.db';
let failed = false;
try { require('./server.js'); } catch (e) { failed = true; }
if (!failed) {
  // if the implementation defers decryption to first use, force it:
  try { require('./server.js').db.prepare('SELECT 1').get(); } catch { failed = true; }
}
if (!failed) throw new Error('wrong passphrase must fail closed');
console.log('enc-failclosed-ok');
" "$(node -e "console.log('/tmp/bd-enc-probe')")" | grep -q enc-failclosed-ok
grep -qi "passphrase" docs/self-hosting.md
grep -qi "at rest\|encrypted" docs/security-model.md
```

## Stop and ask if

- the research recommended field-level (Option B) or filesystem-only
  (Option D) — implement the recommended option, but confirm you are
  allowed to relax the "blob is the backup" acceptance accordingly
- the re-encrypt cadence the research chose risks data loss beyond what the
  docs can honestly promise — tighten the cadence and say so, or stop
- `node:sqlite` on a tmpfs path misbehaves (WAL) in a way the research did
  anticipate — stop with the observed error rather than working around it
  silently

## Notes for the agent

- This is the highest-stakes task in the queue: it owns the integrity of a
  child's record. Prefer boring crypto (the research's primitives), atomic
  replaces (tmp+rename), and fail-closed on any auth error.
- Do not print the passphrase to logs. Ever. The boot log may say "waiting
  for passphrase" and "decrypted OK", nothing else.
- The existing `dbperms.test.js` chmod-0600 expectation composes with this
  (the plaintext temp file must be 0600 too, per 0006).
