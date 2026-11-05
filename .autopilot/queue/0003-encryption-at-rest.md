---
id: 0003
title: Research — SQLite encryption-at-rest design for a zero-dep Node app
plan_ref: C
kind: research
provider: shadowbox
sandbox: research
risk: low
max_iterations: 3
estimated_minutes: 45
---

## Goal

The values doc promises the data is "encrypted in the database and reliably
retrievable" — **including for self-hosted people** (a stolen laptop/VPS disk
must not yield a child's behavioral record). Design how, given the hard
constraint: Node ≥22, `node:sqlite` (plain SQLite, no SQLCipher), and the
"zero npm dependencies" rule. Evaluate and recommend ONE design:

1. **Option A — whole-DB encrypted blob at rest.** On boot: read the
   encrypted file, derive a key from the parent passphrase
   (`scrypt`/`crypto.scryptSync` with per-install salt + iteration count),
   decrypt to a plaintext SQLite file in `tmpfs`/memory (or a chmod-0600 temp
   file), run the app, re-encrypt on a write cadence + clean shutdown
   (`SIGTERM`/`SIGINT`). Questions to answer: does `node:sqlite` run on an
   in-memory or tmpfs file fine (WAL implications?), how to handle a crash
   mid-write (the plaintext temp file is the exposure window — bound it),
   how re-encrypt cadence interacts with WAL, backup story (the encrypted
   blob IS the portable backup), recovery story (forgot passphrase = data
   gone, or do we offer a key file / recovery phrase?), migration of an
   existing plaintext install (one-time `encrypt` command).
2. **Option B — field-level AES-GCM** on the sensitive columns (child name,
   notes, ABC entries, plan labels) with a key derived from a passphrase;
   metadata (schedules, counts) stays plaintext. Cheaper, but "encrypted in
   the database" is only partially true — argue whether that satisfies the
   promise or not.
3. **Option C — SQLCipher / external tooling.** Violates zero-dep; note
   exactly why it is rejected (native binding, supply chain, image size)
   OR a strong case to reconsider.
4. **Option D — filesystem/LUKS/restic only.** Not an app-level guarantee;
   document why it is insufficient for the promise and when it is a fine
   complement.

For the RECOMMENDED option, give: the exact file layout (what is on disk,
plaintext vs encrypted, at which paths), the boot sequence, the
encryption/decryption primitives from `node:crypto` (algorithm, key
derivation, IV/nonce handling, authentication tag), the crash/consistency
model, the backup/restore procedure a family would follow, the passphrase
UX (where it is entered, never stored, how a second parent gets access —
same passphrase vs a second key), performance expectations for a
tens-of-MB DB, and a threat table (stolen disk, VPS provider, local other
user, backup leak, passphrase loss).

Write to `.autopilot/research/0003/output.md` with sections `## Options`,
`## Recommendation`, `## Design` (layout, boot, crypto, consistency,
backup, recovery, UX), `## Threat table`, `## Open questions`. Cite URLs
for any crypto-practice claims (NIST/OWASP). This feeds task 0018.

## Files in scope

- .autopilot/research/0003/output.md (new)

## Files explicitly out of scope

- every other file (research profile is read-only on tracked files)

## Acceptance

```sh
test -s .autopilot/research/0003/output.md
[ "$(wc -c < .autopilot/research/0003/output.md)" -gt 6000 ]
grep -q "## Recommendation" .autopilot/research/0003/output.md
grep -q "## Design" .autopilot/research/0003/output.md
grep -q "## Threat table" .autopilot/research/0003/output.md
grep -qi "scrypt\|argon" .autopilot/research/0003/output.md
grep -qi "AES-GCM\|aes-256-gcm\|ChaCha20" .autopilot/research/0003/output.md
grep -qi "WAL" .autopilot/research/0003/output.md
[ "$(grep -c 'https://' .autopilot/research/0003/output.md)" -ge 5 ]
```

## Stop and ask if

- `node:sqlite` cannot credibly run on a tmpfs/memory file with WAL (this
  would force Option B or D) — recommend the fallback explicitly
- the only sound design requires abandoning zero-dep (a SQLCipher binding)
  — present that tradeoff clearly and mark it as a decision for the human
