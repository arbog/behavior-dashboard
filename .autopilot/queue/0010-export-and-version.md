---
id: 0010
title: JSON export endpoint + version in /healthz + update nudge
plan_ref: K
provider: evobox
sandbox: node
risk: medium
max_iterations: 3
estimated_minutes: 40
---

## Goal

The family's data must be "reliably retrievable" (VALUES.md). Three pieces:

1. **Export.** `GET /api/admin/export` (admin-gated, audited as
   `admin_write`-adjacent kind `export`): returns a JSON document
   `{ app: 'behavior-dashboard', version, exported_at, tables: { <every
   table>: [rows] } }` — all rows, no redaction (it is their data, and the
   response requires a full admin session). `Content-Disposition:
   attachment; filename="behavior-dashboard-<date>.json"` and
   `cache-control: no-store`. The browser UI gets a "Download my data"
   button in Settings (anchor with `download` attribute is not needed — a
   fetch+blob download or a plain link both work; simplest is a link that
   the server can serve).
2. **Version.** Read `version` from `package.json` once at boot. `GET
   /healthz` response becomes `{ ok: true, db: true, version: "x.y.z" }`
   (additive — existing consumers only check `ok`/`db`, tests assert the
   new field).
3. **Update nudge.** In `public/admin.html` header area: a tiny dim line
   "v<current>" that, on load, fetches
   `https://api.github.com/repos/arbog/behavior-dashboard/releases/latest`
   (browser-side, with a 3s `AbortSignal.timeout`) and shows "new version
   available: vY" if `tag_name` (strip leading `v`) is greater than current
   (numeric semver compare), or nothing on failure/rate-limit (fail silent —
   a LAN deploy without internet must not nag). This requires widening the
   CSP `connect-src` to include `https://api.github.com` while keeping
   `default-src 'self'` for everything else.

## Files in scope

- server.js
- server.test.js
- public/admin.html
- docs/self-hosting.md (backup & restore section: the export endpoint is the
  first-class backup; keep the sqlite .backup note as the raw option)

## Files explicitly out of scope

- hardening.test.js, dbperms.test.js, compose.yaml, Dockerfile, .github/*,
  package.json (do NOT bump the version — just read it)

## Acceptance

```sh
node --test
node -e "
process.env.DB_PATH = ':memory:';
process.env.SETUP_TOKEN = 'c'.repeat(64);
const { server, db } = require('./server.js');
server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const setup = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', token: 'c'.repeat(64) }) });
  const ck = setup.headers.get('set-cookie').split(';')[0];
  const h = await fetch(base + '/healthz');
  const hb = await h.json();
  if (!hb.version) throw new Error('healthz must carry version');
  const x = await fetch(base + '/api/admin/export', { headers: { cookie: ck } });
  if (x.status !== 200) throw new Error('export must be 200, got ' + x.status);
  if (!/attachment/.test(x.headers.get('content-disposition') || '')) throw new Error('export must be an attachment');
  const body = await x.json();
  if (!body.tables || !body.tables.modes || !body.tables.settings) throw new Error('export must include all tables');
  if (!body.version || !body.exported_at) throw new Error('export must be self-describing');
  const noauth = await fetch(base + '/api/admin/export');
  if (noauth.status !== 401) throw new Error('export without session must be 401, got ' + noauth.status);
  server.close();
  console.log('export-ok');
});
" | grep -q export-ok
grep -q "api.github.com" server.js
grep -q "Download my data" public/admin.html
grep -qi "export" docs/self-hosting.md
```

## Stop and ask if

- `GET /api/admin/export` should also be callable with a kiosk token or API
  key (default: admin session only — this task predates 0012's API keys)
- the CSP widening to `connect-src` for api.github.com should instead be a
  `script-src`/fetch via a same-origin proxy route (default: direct CSP
  widening is fine; say so if you think the proxy is warranted)

## Notes for the agent

- The nudge must be fail-silent: wrap the fetch so a network error, a 403
  rate-limit, or a malformed tag produces no visible change and no console
  spam (one `console.warn` max).
- Export ordering: dump tables in a stable order and include `sqlite_master`
  table NAMES only (not the DDL) so the consumer knows the schema version by
  the app version field.
