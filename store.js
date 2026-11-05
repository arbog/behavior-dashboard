'use strict';
// ---- 0018: encryption at rest — the whole-DB encrypted blob (Option A) ----
// At rest, the data directory holds one ciphertext blob (`board.enc`, next to
// the configured DB_PATH). On boot the store derives a key from the
// passphrase (scrypt), decrypts to a working copy, and runs SQLite against
// that; a 30 s cadence + clean shutdown re-encrypt. Design and verified
// facts: docs/research/encryption.md. Zero npm dependencies.
//
// Honest bounds (state them to families): a hard crash loses at most the
// re-encrypt cadence of writes — unless the working copy survived, in which
// case boot reconciliation recovers it. A lost passphrase is lost data; the
// blob is useless without it, by design.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Blob format (versioned, AEAD). Any auth failure = refuse to open, fail closed.
//   0..3 magic "BDB1" | 4 version | 5 kdf id (1=scrypt) | 6 aead id (1=AES-256-GCM)
//   7 reserved | 8..11 scrypt log2(N) | 12..15 r | 16..19 p
//   20..51 salt | 52..63 iv | 64..79 GCM tag | 80.. ciphertext
const MAGIC = Buffer.from('BDB1');
const VERSION = 1;
const HDR = 80;
const LOG_N = 15, SCRYPT_R = 8, SCRYPT_P = 1;   // N=32768: ~50–200 ms once per boot

const deriveKey = (pass, salt, logN, r, p) =>
  crypto.scryptSync(String(pass).normalize('NFKC'), salt, 32, { N: 1 << logN, r, p, maxmem: 1 << 27 });

function encryptBlob(dbBytes, pass, opts = {}) {
  const logN = opts.logN ?? LOG_N, r = opts.r ?? SCRYPT_R, p = opts.p ?? SCRYPT_P;
  const salt = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const header = Buffer.alloc(HDR);
  MAGIC.copy(header, 0);
  header[4] = VERSION; header[5] = 1; header[6] = 1; header[7] = 0;
  header.writeUInt32BE(logN, 8); header.writeUInt32BE(r, 12); header.writeUInt32BE(p, 16);
  salt.copy(header, 20); iv.copy(header, 52);
  const key = deriveKey(pass, salt, logN, r, p);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header.subarray(0, 64));   // binds KDF params + salt + iv to the ciphertext: a param downgrade breaks the tag
  const ct = Buffer.concat([cipher.update(dbBytes), cipher.final()]);
  cipher.getAuthTag().copy(header, 64);
  return Buffer.concat([header, ct]);
}

function decryptBlob(blob, pass) {
  if (!Buffer.isBuffer(blob) || blob.length <= HDR) throw new Error('blob: not a board blob');
  if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error('blob: not a board blob');
  if (blob[4] !== VERSION) throw new Error(`blob: unknown format version ${blob[4]}`);
  if (blob[5] !== 1 || blob[6] !== 1) throw new Error('blob: unknown kdf/aead ids');
  if (blob[7] !== 0) throw new Error('blob: bad reserved byte');
  const logN = blob.readUInt32BE(8), r = blob.readUInt32BE(12), p = blob.readUInt32BE(16);
  const salt = blob.subarray(20, 52), iv = blob.subarray(52, 64), tag = blob.subarray(64, 80), ct = blob.subarray(HDR);
  const key = deriveKey(pass, salt, logN, r, p);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(blob.subarray(0, 64));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);   // throws on tag mismatch — fail closed
}

const writeAtomic = (p, data) => {
  const tmp = `${p}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
  try { fs.fsyncSync(fs.openSync(path.dirname(p), 'r')); } catch {}   // rename durability
};

// A writable tmpfs is the preferred working-copy home: a host reboot wipes
// it, which is the safest crash story. Fall back to the data dir (0600).
function workDirFor(dataDir) {
  try {
    if (process.platform !== 'win32' && fs.existsSync('/dev/shm')) {
      const probe = `/dev/shm/bd-probe-${process.pid}`;
      fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
      return '/dev/shm';
    }
  } catch {}
  return dataDir;
}

function openStore({ dbPath, log = () => {} }) {
  if (dbPath === ':memory:') {
    const db = new DatabaseSync(':memory:');
    return { db, encrypted: false, persist() {}, close() { try { db.close(); } catch {} } };
  }
  const dataDir = path.dirname(dbPath);
  fs.mkdirSync(dataDir, { recursive: true });
  const blobPath = path.join(dataDir, 'board.enc');
  const workDir = workDirFor(dataDir);
  const workPath = path.join(workDir, path.basename(dbPath) + '.work');
  const want = process.env.BD_ENCRYPTION;
  const envPass = process.env.BD_PASSPHRASE;

  if (want === 'off' || (want !== 'on' && !envPass && !fs.existsSync(blobPath))) {
    // Plaintext mode: the historical behavior. The boot log says plainly what
    // is (not) protecting the data — honest, not silent.
    log(`encryption: OFF (BD_ENCRYPTION=${want || 'unset'}) — the database file itself is unencrypted; set BD_PASSPHRASE to enable the encrypted blob`);
    const db = new DatabaseSync(dbPath);
    return { db, encrypted: false, persist() {}, close() { try { db.close(); } catch {} } };
  }
  // From here on: encryption ON. A passphrase is required and only ever
  // arrives via BD_PASSPHRASE — never argv, never a file, never logged.
  const pass = envPass;
  if (!pass) throw new Error('encryption is on but no passphrase: set BD_PASSPHRASE (headless boots have no TTY to ask on)');
  if (typeof pass !== 'string' || pass.length < 8) throw new Error('BD_PASSPHRASE must be at least 8 characters — a lost passphrase means lost data, so make it one you can keep');

  let recovered = false, migrating = false;
  if (fs.existsSync(blobPath)) {
    // Reconciliation first: a working copy newer than the blob means the
    // previous process died dirty — recover it, never silently drop it. In
    // WAL mode writes land in the sidecar, so the WAL's mtime counts too.
    const newestWork = () => {
      let t = fs.statSync(workPath).mtimeMs;
      try { t = Math.max(t, fs.statSync(`${workPath}-wal`).mtimeMs); } catch {}
      return t;
    };
    let plainBytes = null;
    if (fs.existsSync(workPath) && newestWork() > fs.statSync(blobPath).mtimeMs) {
      // Checkpoint through a real connection FIRST — the WAL may hold frames
      // (even the whole schema) that a raw read of the main file would miss.
      const probe = new DatabaseSync(workPath);
      const ok = probe.prepare('PRAGMA integrity_check').get();
      if (ok && ok.integrity_check === 'ok') {
        probe.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        probe.close();
        plainBytes = fs.readFileSync(workPath);
        recovered = true;
      } else {
        probe.close();
        const bak = workPath + '.integrity-fail.bak';
        fs.renameSync(workPath, bak);
        log(`WARNING: the working copy failed its integrity check — moved to ${bak}, falling back to the encrypted blob`);
      }
    }
    if (!plainBytes) {
      try { plainBytes = decryptBlob(fs.readFileSync(blobPath), pass); }
      catch (e) { throw new Error(`the encrypted database could not be opened (${e.message}) — check BD_PASSPHRASE; a wrong passphrase or damaged blob is not recoverable`); }
    }
    for (const side of [`${workPath}-wal`, `${workPath}-shm`]) if (fs.existsSync(side)) fs.unlinkSync(side);
    fs.writeFileSync(workPath, plainBytes, { mode: 0o600 });
  } else if (fs.existsSync(dbPath)) {
    // Legacy migration: encrypt the plaintext DB on first boot, verify the
    // round trip, then remove the plaintext. Never delete before verify.
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const bytes = fs.readFileSync(dbPath);
    db.close();
    if (fs.existsSync(blobPath)) throw new Error('a board.enc appeared mid-migration — refusing to continue');
    writeAtomic(blobPath, encryptBlob(bytes, pass));
    const round = decryptBlob(fs.readFileSync(blobPath), pass);
    if (!round.equals(bytes)) throw new Error('migration verification failed — the plaintext file is left untouched');
    fs.writeFileSync(workPath, bytes, { mode: 0o600 });
    fs.unlinkSync(dbPath);
    for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(side)) fs.unlinkSync(side);
    migrating = true;
    log(`migrated the plaintext database to encrypted storage (${blobPath}) — the plaintext file was removed after verification`);
  } else {
    fs.writeFileSync(workPath, Buffer.alloc(0), { mode: 0o600 });   // fresh: SQLite initializes the empty file
  }

  const db = new DatabaseSync(workPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  fs.chmodSync(workPath, 0o600);
  for (const side of [`${workPath}-wal`, `${workPath}-shm`]) if (fs.existsSync(side)) try { fs.chmodSync(side, 0o600); } catch {}
  if (fs.existsSync(blobPath)) fs.chmodSync(blobPath, 0o600);

  let lastStat = null;   // null: the first persist() always runs — a fresh or migrated board must have its blob immediately
  // The dirty check must see the WAL sidecar: in WAL mode the main file can
  // stay frozen between checkpoints while every write lands in the -wal.
  const snapshot = () => {
    try {
      const s = fs.statSync(workPath);
      let tag = `${s.size}:${s.mtimeMs}`;
      try { const w = fs.statSync(`${workPath}-wal`); tag += `:${w.size}:${w.mtimeMs}`; } catch {}
      return tag;
    } catch { return null; }
  };
  const persist = () => {
    if (!fs.existsSync(workPath)) return;
    const now = snapshot();
    if (now === lastStat) return;   // nothing written since the last persist
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    writeAtomic(blobPath, encryptBlob(fs.readFileSync(workPath), pass));
    lastStat = snapshot();
  };
  // First boot of a fresh or migrated board: the blob must exist immediately.
  if (!fs.existsSync(blobPath)) persist();
  log(`encryption: ON (${blobPath}, working copy in ${workDir}${recovered ? ', recovered unflushed state from a previous run' : ''})`);
  return {
    db, encrypted: true, blobPath, workPath, persist,
    close() {
      try { persist(); } catch (e) { log(`final persist failed: ${e.message}`); }
      try { db.close(); } catch {}
      for (const p of [workPath, `${workPath}-wal`, `${workPath}-shm`]) if (fs.existsSync(p)) fs.unlinkSync(p);
    },
  };
}

module.exports = { openStore, encryptBlob, decryptBlob, MAGIC, HDR };
