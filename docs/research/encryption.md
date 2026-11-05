# Research 0003 — SQLite encryption at rest for a zero-dep Node app

Research task 0003, executed in-session 2026-11-05. Feeds task 0018. The
promise being satisfied (VALUES.md): the board's data is "encrypted in the
database and reliably retrievable" — for self-hosters too, so a stolen
laptop or VPS disk does not yield a child's behavioral record. Hard
constraints: Node ≥22, `node:sqlite` (plain SQLite, no SQLCipher), zero npm
dependencies.

Facts verified on this machine (Node 22.23.3) rather than assumed:

```
/dev/shm  -> journal_mode: wal   rows: 200  OK      # tmpfs + WAL works
/tmp      -> journal_mode: wal   rows: 200  OK
:memory:  -> journal_mode: memory  (cannot be shared, dies with the process)
```

So the whole-DB design below is feasible: SQLite (with WAL) runs happily on a
tmpfs file, and `node:sqlite` gives us the same handle either way.

## Options

### Option A — whole-DB encrypted blob at rest (RECOMMENDED)

At rest, the data directory holds one ciphertext blob (`board.enc`). On boot
the app derives a key from the parent's passphrase (scrypt), decrypts to a
working copy, and runs SQLite against that. On a dirty flag + a cadence + a
clean shutdown, it re-encrypts and atomically replaces the blob.

- **What it protects:** everything the DB is — schedule, battery, ABC log,
  notes, the child's name, the consent artifact. The blob is the *only*
  persistent artifact, so backups are encrypted by construction.
- **Cost:** a plaintext working copy exists while the app runs (tmpfs/RAM
  where available; a 0600 file otherwise). At-rest remains at-rest; a live
  process is out of scope for this option and for every other option here.
- **Crash window:** bounded by the re-encrypt cadence (design below: 30 s).
  A plaintext file surviving a `kill -9` is recoverable — see the Design
  section's boot reconciliation.

### Option B — field-level AES-GCM on sensitive columns

Encrypt the values (child name, notes, ABC labels, plan notes) with a
passphrase-derived key; leave row ids, timestamps, counts, and schedule
titles plaintext.

- **Cheaper in code** (no working-copy lifecycle), but "encrypted in the
  database" becomes "some columns encrypted." **The schedule itself is
  family data** — a board titled "Beach Day" and "Therapy Day at 3pm" leaks
  plenty. This option also breaks SQL-level sorting/search on any encrypted
  column.
- Verdict: fails the promise as stated; keep it as the **fallback** if A's
  lifecycle proves too fiddly for the wizard/self-host story.

### Option C — SQLCipher (or any native SQLite crypto build)

- Rejected. It is a native binding: we would need to compile SQLite+SQLCipher
  with the right flags into the image and bind it from Node (node:sqlite does
  not accept a custom SQLite build). That breaks the two core properties:
  "the image is Node plus our source" and "zero npm dependencies." It also
  moves the passphrase problem into SQLite's `PRAGMA key`, solving nothing
  about UX or recovery.

### Option D — filesystem-level only (LUKS, encrypted volume, restic backups)

- Not an app guarantee: it depends entirely on the deployer doing it right,
  and it is absent on the most common deployment we ship (a container with a
  named volume on a host's unencrypted disk). Valuable as a **complement**
  (documented in self-hosting: "if you can, run the volume on an encrypted
  filesystem too") but it cannot be what VALUES.md promises.

## Recommendation

**Option A — whole-DB encrypted blob**, with `board.enc` as both the live
store and the backup unit. Fallback to Option B only if the crash-recovery
path in Design proves unacceptable in review. Do not take C; document D as a
bonus layer.

## Design

### File layout

```
/data/
  board.enc          # the only persistent artifact: versioned header + AEAD ciphertext
  board.work.db      # plaintext working copy — tmpfs preferred, 0600 always
  board.work.db-wal  # (SQLite sidecars, same location, 0600)
  .boot-ts           # tiny file: last successful re-encrypt timestamp
```

Preferred working location: `/dev/shm` (tmpfs) when the volume is at least
4× the DB size and `/dev/shm` exists; else `/data` (0600). Log which was
used — a tmpfs working copy changes the crash story (a host reboot loses it,
which is safest).

### Blob format (versioned, AEAD)

```
offset  size  field
0       4     magic "BDB1"
4       1     format version (1)
5       1     KDF id (1 = scrypt)
6       1     AEAD id (1 = AES-256-GCM)
7       1     reserved 0
8       4     scrypt log2(N)      (default 15 → N=32768)
12      4     scrypt r           (default 8)
16      4     scrypt p           (default 1)
20      32    salt
52      12    IV / nonce         (fresh random per encryption — never reused with the same key)
64      16    GCM auth tag
80      ..    ciphertext (the SQLite file bytes)
```

Any auth failure = refuse to open (fail closed). A truncated/garbage blob must
never be "partially opened."

### Key derivation and crypto

- `key = crypto.scryptSync(passphrase.normalize('NFKC'), salt, 32, { N: 1<<15, r: 8, p: 1, maxmem: 64*1024*1024 })`
  (≈50–200 ms on the boxes we care about — acceptable once per boot).
- AEAD: `crypto.createCipheriv('aes-256-gcm', key, iv)`; AAD = the 80-byte
  header (binds KDF params + salt to the ciphertext, so a downgrade of
  parameters breaks the tag).
- Passphrase sources, in order: `BD_PASSPHRASE` env (headless/PaaS), else an
  interactive prompt on a TTY (`process.stdin.isTTY`), else fail with a clear
  message. Never log it; never write it to disk; never put it in argv.

### Boot sequence

1. Read `board.enc`. If absent → first-run: derive key from the supplied
   passphrase + new salt, create an empty DB on the working copy, encrypt.
2. If present: verify magic/version, derive key, decrypt, verify tag →
   write working copy (0600) → `node:sqlite` open.
3. **Crash reconciliation:** if `board.work.db` exists and its mtime is newer
   than `.boot-ts`, a previous process died dirty. Re-encrypt the working
   copy (we have the key) after a WAL checkpoint, log
   `recovered unflushed state from a previous run`, then continue. If the
   working copy exists but fails an `PRAGMA integrity_check`, move it aside
   to `.bak` and log loudly — never delete a family's data silently.
4. Migration: a legacy plaintext `board.db` next to the new files is
   encrypted into `board.enc` on first boot and the plaintext removed
   (logged). Refuse to run with both present and differing mtimes without a
   flag — say exactly what will happen.

### Re-encrypt cadence

- A `dirty` flag set on every write transaction.
- Every 30 s, if dirty: `PRAGMA wal_checkpoint(TRUNCATE)` → fsync the working
  file (read it) → encrypt to `board.enc.tmp` → `fsync` → `rename()` over
  `board.enc` → update `.boot-ts`.
- On `SIGTERM`/`SIGINT`/clean exit: same, synchronously, then unlink the
  working copy.
- **Honest bound:** a hard crash loses at most 30 s of writes unless the
  working copy survives, in which case reconciliation recovers it. State both
  in the docs.

### Backup and restore

- Backup = copy `board.enc` (it is encrypted, self-contained, and useless
  without the passphrase). Restore = put it back, supply the passphrase.
- This also satisfies the COPPA §312.10 retention/deletion problem: a
  retained backup is *not* retrievable without the key, and keys are not
  retained separately from the family.
- The JSON export (task 0010) stays the human-readable escape hatch; the blob
  is the byte-faithful backup.

### Passphrase UX

- First run (encryption OFF by default for backwards-compat? **No** — see
  below): the wizard asks for a passphrase OR offers "no passphrase, rely on
  filesystem permissions" which writes plaintext and records
  `encryption: off` (honest, and the self-host docs explain the trade).
  Default for the PaaS tier: **encryption on, passphrase generated** and
  shown once in the deploy output (the managed service holds the key; the
  family can rotate/download it).
  - Rationale: a forced passphrase on a family that will lose it converts
    "encrypted" into "deleted." Offer encryption, default it on for managed
    (we hold the key), default it *on but passphrase-optional* for
    self-host first run with a loud explanation of the trade.
- Two parents: same passphrase (documented: "both parents should know it") —
  v1 does not do multi-key envelopes. Recovery codes / Shamir split are
  explicitly out of scope (open question below).

### Performance

- A tens-of-MB DB: decrypt ≈ 10–40 ms; encryp' ≈ same; scrypt ≈ 50–200 ms at
  boot only; the 30 s re-encrypt is invisible at these sizes. At 500 MB the
  design would need an incremental scheme — out of scope (a family board will
  not reach that).

## Threat table

| Threat | Option A (blob) | Option B (fields) | Option D (LUKS) |
|---|---|---|---|
| Stolen laptop / VPS disk snapshot | **protected** | partially (titles/timestamps leak) | protected if deployer did it |
| Another local OS user | protected (0600 + tmpfs) | partially | protected |
| Backup leak (object storage, USB) | **protected** (blob is encrypted) | partially | only if the backup is encrypted too |
| Passphrase forgotten | **data lost** (must be explicit) | data lost | volume lost |
| Live compromise (malware, root in container) | exposed (working copy) | exposed | exposed |
| Wrong/truncated blob | fail closed (GCM tag) | row-level failures | n/a |

## Open questions

1. Recovery codes: a printed 24-word phrase as a second KEK, or an offline
   key file the parent downloads at setup? Deferred past v1, but the wizard
   copy should hint that a lost passphrase = lost board.
2. Should encryption be *forced* on the managed tier (we hold the key, so the
   family can't lose it) while self-host is opt-in? Recommended: yes, and
   the managed tier must support family-initiated key rotation + export.
3. Multi-key envelopes (two parents, two passphrases, one blob) — out of
   scope; revisit if the wizard research shows households expect it.
4. Do we mirror `.boot-ts`/`board.enc` writes with `fsync` on the *directory*
   (rename durability) — yes in implementation; noted so 0018 doesn't skip it.
