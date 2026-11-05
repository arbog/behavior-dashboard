'use strict';
// 0009 migration: an install that predates per-device codes had ONE shared
// token in settings. Boot must import it as a named device that still works.
process.env.DB_PATH = `/tmp/bd-kiosk-mig-${process.pid}/board.db`;
delete process.env.SETUP_TOKEN;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dir = path.dirname(process.env.DB_PATH);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const LEGACY = 'legacy' + 'c'.repeat(56);
{
  // Pre-seed the OLD shape: a settings row, no kiosk_devices table.
  const pre = new DatabaseSync(process.env.DB_PATH);
  pre.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)');
  pre.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('kiosk_token', LEGACY);
  pre.close();
}

const { server, db } = require('./server.js');
let base;
test.before(async () => {
  await new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }));
});
test.after(() => { try { server.close(); } catch {}; db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the shared legacy code is imported as "Original kiosk" and still works', async () => {
  const dev = db.prepare("SELECT id,label,revoked_at FROM kiosk_devices WHERE label='Original kiosk'").get();
  assert.ok(dev, 'legacy token imported as a named device');
  assert.equal(dev.revoked_at, null);
  const r = await fetch(base + '/api/today', { headers: { 'x-kiosk-token': LEGACY } });
  assert.equal(r.status, 200, 'the legacy code keeps authenticating after migration');
});
