---
id: 0009
title: Per-device kiosk codes (replace the single shared token)
plan_ref: K
provider: evobox
sandbox: node
risk: medium
max_iterations: 3
estimated_minutes: 45
---

## Goal

One shared kiosk code means you can't revoke "the TV" without revoking
"everyone", and "last used" can't say WHICH device. Replace the single
`kiosk_token` setting with a set of named kiosk devices:

- New table `kiosk_devices (id, label, token_hash, created_at,
  last_used_at, revoked_at)`. `token_hash` is the SHA-256 of the token (the
  raw token is shown once at creation, like sessions).
- **Migration**: on boot, if `kiosk_devices` is empty and the legacy
  `settings.kiosk_token` exists, import it as a device labeled
  `Original kiosk` (hash its stored raw token, keep it working). Then the
  legacy setting is left in place (harmless) but all auth reads the table.
- `kioskAuthed` checks the presented token (header always; `?token=` only on
  initial `GET /api/today` as today) against every NON-revoked device's
  `token_hash` using `crypto.timingSafeEqual` on the SHA-256 of the
  presented value (compare hashes, constant-time, one pass over the rows).
  On success, note `last_used_at` for that device (throttled 60s, in-memory,
  like the kiosk note today).
- Endpoints (admin-gated, audited as `kiosk_device_*`):
  - `GET /api/admin/kiosk-devices` → `[{ id, label, created_at, last_used_at, revoked_at }]`
  - `POST /api/admin/kiosk-devices { label }` → creates + returns the RAW
    token once (`{ id, label, token }`). Cap at 8 active devices (400 above
    that); label required, 1–40 chars.
  - `DELETE /api/admin/kiosk-devices/:id` → sets `revoked_at` (soft revoke so
    the audit trail keeps the row).
- The single `kiosk_last_used` setting note is REPLACED by per-device
  `last_used_at`; update `GET /api/admin/security` to include
  `kiosk_devices: [...]` (label + last_used_at, non-revoked) and drop the
  stale single note from the Settings UI.
- UI (`public/admin.html` Settings): the "Kiosk code" card becomes
  "Kiosk devices": a list (label, last used, revoke button), an "Add device"
  row that, on create, shows the new token once in a copyable field with the
  `/?token=…` deep link, and the rotate button is removed (revoke+add is the
  rotate). Keep the wording kind and plain.
- Docs: `docs/security-model.md` (shared token → per-device, revocation
  granularity) and `docs/self-hosting.md` (kiosk appliance section: add each
  device once).

## Files in scope

- server.js
- server.test.js
- public/admin.html
- docs/security-model.md
- docs/self-hosting.md

## Files explicitly out of scope

- hardening.test.js, dbperms.test.js, compose.yaml, Dockerfile, .github/*

## Acceptance

```sh
node --test
node -e "
process.env.DB_PATH = ':memory:';
process.env.SETUP_TOKEN = 'b'.repeat(64);
const { server, db } = require('./server.js');
server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const setup = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', token: 'b'.repeat(64) }) });
  const ck = setup.headers.get('set-cookie').split(';')[0];
  const H = { cookie: ck, 'content-type': 'application/json' };
  // legacy import: seed a legacy token then verify it still works
  db.prepare(\"INSERT INTO settings(key,value) VALUES('kiosk_token','legacy' + 'c'.repeat(56)) ON CONFLICT(key) DO UPDATE SET value=excluded.value\").run();
  // note: migration runs at boot, so instead test the fresh-create path directly:
  const created = await (await fetch(base + '/api/admin/kiosk-devices', { method: 'POST', headers: H, body: JSON.stringify({ label: 'Kitchen TV' }) })).json();
  if (!created.token || !/^[0-9a-f]{48}$/.test(created.token)) throw new Error('create must return a 48-hex raw token once');
  const ok = await fetch(base + '/api/today', { headers: { 'x-kiosk-token': created.token } });
  if (ok.status !== 200) throw new Error('new device token must authenticate, got ' + ok.status);
  const list = await (await fetch(base + '/api/admin/kiosk-devices', { headers: H })).json();
  if (!list.some(d => d.label === 'Kitchen TV' && !d.revoked_at)) throw new Error('device must appear active');
  const del = await fetch(base + '/api/admin/kiosk-devices/' + created.id, { method: 'DELETE', headers: H });
  if (del.status !== 200) throw new Error('revoke must be 200');
  const dead = await fetch(base + '/api/today', { headers: { 'x-kiosk-token': created.token } });
  if (dead.status !== 401) throw new Error('revoked device token must be dead, got ' + dead.status);
  // cap at 8 active
  let capHit = false;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(base + '/api/admin/kiosk-devices', { method: 'POST', headers: H, body: JSON.stringify({ label: 'd' + i }) });
    if (r.status === 400) { capHit = true; break; }
  }
  if (!capHit) throw new Error('expected the 8-active cap to trigger 400');
  server.close();
  console.log('kiosk-devices-ok');
});
" | grep -q kiosk-devices-ok
grep -q "Kiosk devices" public/admin.html
grep -qi "per-device\|each device" docs/security-model.md
```

## Stop and ask if

- the legacy migration should run BEFORE or AFTER task 0007's setup-token
  boot ordering (they both touch boot) — default: kiosk migration first,
  setup-token second; ask if that ordering creates a boot-log tangle
- the 8-device cap should be env-tunable (default: no, keep it fixed)

## Notes for the agent

- Keep `?token=` restricted to initial `GET /api/today` EXACTLY as today —
  this task changes which tokens are valid, not where they may ride.
- `GET /api/admin/security` consumers (the Settings security-log card) read
  `kiosk_last_used` — update that UI to read `kiosk_devices` instead.
