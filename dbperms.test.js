'use strict';
// 0006: the data directory and SQLite file are a child's behavioral record and
// must be owner-only. This suite uses a real on-disk DB (the other suites use
// :memory:, where there is nothing to protect) and asserts the boot-time chmod.
process.env.DB_PATH = `/tmp/bd-perm-${process.pid}/board.db`;
delete process.env.SETUP_TOKEN;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.dirname(process.env.DB_PATH);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
// Deliberately permissive before boot: the server must fix this itself.
fs.chmodSync(dir, 0o777);

const { server, db } = require('./server.js');
const mode = p => fs.statSync(p).mode & 0o777;

test.after(() => {
  try { server.close(); } catch {}
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the data directory is 0700 and the database file 0600 after boot', () => {
  assert.equal(mode(dir).toString(8), '700', 'data dir must not be group/world accessible');
  assert.equal(mode(process.env.DB_PATH).toString(8), '600', 'database file must be owner-only');
});

test('wal/shm sidecars are owner-only too once they exist', () => {
  db.prepare('CREATE TABLE IF NOT EXISTS probe(x)').run();
  db.prepare('INSERT INTO probe VALUES (1)').run();
  // Touch a checkpoint so the sidecars are real, then re-assert via a fresh boot
  // path: the sidecars, if present, must be 0600 (the boot hook chmods them).
  for (const p of [`${process.env.DB_PATH}-wal`, `${process.env.DB_PATH}-shm`]) {
    if (fs.existsSync(p)) assert.equal(mode(p).toString(8), '600', `${p} must be owner-only`);
  }
});
