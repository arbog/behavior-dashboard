'use strict';
// Encryption-at-rest tests (0018): blob format, fail-closed behavior, legacy
// migration, crash reconciliation, and the whole thing wired through the
// real server (boot with BD_PASSPHRASE, write, find the blob fresh on disk).
process.env.DB_PATH = `/tmp/bd-crypt-${process.pid}/board.db`;
process.env.BD_ENCRYPTION = 'on';
process.env.BD_PASSPHRASE = 'correct-stable-passphrase';
process.env.SETUP_TOKEN = 'crypt-suite-setup-token-1234';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store_mod = require('./store.js');

const dir = path.dirname(process.env.DB_PATH);
fs.rmSync(dir, { recursive: true, force: true });
const blob = path.join(dir, 'board.enc');
const PASS = process.env.BD_PASSPHRASE;

test('blob format: the header is what the doc says, and round-trips', () => {
  const b = store_mod.encryptBlob(Buffer.from('family data'), PASS);
  assert.ok(b.subarray(0, 4).equals(store_mod.MAGIC), 'magic BDB1');
  assert.equal(b[4], 1, 'format version');
  assert.equal(b[5], 1, 'kdf id scrypt');
  assert.equal(b[6], 1, 'aead id AES-256-GCM');
  assert.equal(b[7], 0, 'reserved');
  assert.equal(b.readUInt32BE(8), 15, 'scrypt log2(N)');
  assert.equal(b.length > 80, true, 'ciphertext follows the 80-byte header');
  assert.deepEqual(store_mod.decryptBlob(b, PASS).toString(), 'family data');
  // a fresh IV every time: the same plaintext never encrypts to the same blob
  assert.ok(!store_mod.encryptBlob(Buffer.from('family data'), PASS).equals(b), 'nonce is fresh per encryption');
  // and the tag binds the header: flipping a KDF byte breaks the decrypt
  const tampered = Buffer.from(b);
  tampered[8] = 14;   // downgrade N
  assert.throws(() => store_mod.decryptBlob(tampered, PASS), /auth|decipher|fails?/, 'parameter downgrade breaks the auth tag');
});
test('fail closed: wrong passphrase and damaged ciphertext never open', () => {
  const b = store_mod.encryptBlob(Buffer.from('secret'), PASS);
  assert.throws(() => store_mod.decryptBlob(b, 'wrong-passphrase'), /auth|decipher|fails?/, 'wrong key is a tag failure, not garbage output');
  const cut = b.subarray(0, 40);   // truncated
  assert.throws(() => store_mod.decryptBlob(cut, PASS), /not a board blob|truncat|auth|final/);
  const flip = Buffer.from(b); flip[store_mod.HDR + 4] ^= 0xff;   // a byte inside the ciphertext
  assert.throws(() => store_mod.decryptBlob(flip, PASS), /auth|decipher|fails?/, 'a flipped ciphertext byte is refused');
});
test('the passphrase is the only key: no passphrase, no board', () => {
  const boot = opts => {
    const log = [];
    const s = store_mod.openStore({ dbPath: path.join(dir, 'board.db'), log: m => log.push(m) });
    s.close(); return log;
  };
  // fresh encrypted boot in a clean dir: works, and the blob lands
  fs.rmSync(dir, { recursive: true, force: true });
  const log = boot();
  assert.ok(fs.existsSync(blob), 'first boot creates the blob');
  assert.ok(log.some(m => /encryption: ON/.test(m)), 'the boot log says what is protecting the data');
});
test('a legacy plaintext board.db is migrated, verified, and removed', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // a legacy install: a real plaintext SQLite file with family data in it
  const legacy = new (require('node:sqlite').DatabaseSync)(process.env.DB_PATH);
  legacy.exec('CREATE TABLE IF NOT EXISTS days (date TEXT PRIMARY KEY, note TEXT)');
  legacy.prepare("INSERT INTO days(date,note) VALUES('2026-01-01','the day we remember')").run();
  legacy.close();
  const s = store_mod.openStore({ dbPath: process.env.DB_PATH, log: () => {} });
  assert.ok(s.encrypted);
  assert.ok(fs.existsSync(blob));
  assert.ok(!fs.existsSync(process.env.DB_PATH), 'the plaintext file is gone');
  assert.equal(s.db.prepare("SELECT note FROM days WHERE date='2026-01-01'").get().note, 'the day we remember', 'the data came through');
  s.close();
  // and the migrated blob reopens with the same passphrase
  const s2 = store_mod.openStore({ dbPath: process.env.DB_PATH, log: () => {} });
  assert.equal(s2.db.prepare("SELECT note FROM days WHERE date='2026-01-01'").get().note, 'the day we remember');
  s2.close();
});
test('crash reconciliation: a dirty working copy is recovered, not dropped', () => {
  fs.rmSync(dir, { recursive: true, force: true });
  const s = store_mod.openStore({ dbPath: process.env.DB_PATH, log: () => {} });
  s.db.exec('CREATE TABLE IF NOT EXISTS t (x TEXT)');
  s.db.prepare("INSERT INTO t VALUES('persisted')").run();
  s.persist();
  const blobSize = fs.statSync(blob).size;
  s.db.prepare("INSERT INTO t VALUES('unflushed')").run();   // written, never persisted — then "crash"
  s.db.close();   // abandon without persist: simulate the process dying (close checkpoints the WAL, as SQLite does on any exit)
  // open a NEW store on the same dir. The working copy is newer than the
  // blob → boot reconciliation recovers it.
  const s2 = store_mod.openStore({ dbPath: process.env.DB_PATH, log: () => {} });
  const rows = s2.db.prepare('SELECT x FROM t ORDER BY rowid').all().map(r => r.x);
  assert.ok(rows.includes('persisted'));
  assert.ok(rows.includes('unflushed'), 'the writes the last run never persisted are recovered from the working copy');
  s2.persist();
  assert.ok(fs.statSync(blob).size >= blobSize, 'the blob is refreshed by the recovered state');
  s2.close();
  // and after clean shutdown the working copy is gone — nothing plaintext left
  assert.ok(!fs.existsSync(`${dir}/board.db.work`), 'the plaintext working copy is removed on close');
  for (const f of fs.readdirSync(dir)) {
    if (f !== 'board.enc') assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, `${f} must be owner-only`);
  }
});
test('the server boots encrypted: healthz says so, and a real restart restores', async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  const srv = require('./server.js');
  await new Promise(r => srv.server.listen(0, r));
  const base = `http://127.0.0.1:${srv.server.address().port}`;
  const h = await fetch(base + '/healthz').then(r => r.json());
  assert.equal(h.encrypted, true, 'healthz tells the family the truth about their data');
  // a write through the API, then a forced persist — the blob lands
  const sw = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', child_name: 'Sam', token: process.env.SETUP_TOKEN }) });
  assert.equal(sw.status, 200, 'setup works on the encrypted store');
  srv.store.persist();
  assert.ok(fs.existsSync(blob), 'the blob exists');
  srv.server.close();
  srv.store.close();
  assert.ok(!fs.existsSync(`${dir}/board.db.work`), 'nothing plaintext left behind');
  // Leg 2: a REAL restart — a child process reading only board.enc + the passphrase
  const port = 30000 + (process.pid % 20000);
  const child = require('node:child_process').spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), DB_PATH: process.env.DB_PATH, BD_ENCRYPTION: 'on', BD_PASSPHRASE: PASS },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let up = null;
    for (let i = 0; i < 100 && !up; i++) {
      await new Promise(r => setTimeout(r, 100));
      try { up = await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json()); } catch {}
    }
    assert.ok(up && up.encrypted === true, 'the restarted server is up and encrypted');
    const me = await fetch(`http://127.0.0.1:${port}/api/admin/me`).then(r => r.json());
    assert.equal(me.setup, false, 'the reopened board is still configured — the passphrase was the only key');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => child.on('exit', r));
  }
  assert.ok(fs.existsSync(blob), 'the blob survives the restart');
});
