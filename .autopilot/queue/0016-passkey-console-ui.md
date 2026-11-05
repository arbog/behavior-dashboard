---
id: 0016
title: Passkey console UI (enroll card + login button)
plan_ref: P
provider: evobox
sandbox: node
risk: high
max_iterations: 5
estimated_minutes: 45
thinking: high
---

## Goal

Wire the WebAuthn server endpoints from 0015 into the console so a parent
can enroll a passkey and sign in with it. **Depends on 0015 being merged —
read the actual endpoint shapes in `server.js` first; if 0015 is not present
(its routes missing), STOP and ask.**

In `public/admin.html`:
1. **Login screen** (`showAuth`): when the board has ≥1 enrolled credential
   (add a cheap, non-gated signal to `GET /api/admin/me` of the form
   `webauthn: true` — this is the ONE server change allowed in this task,
   and it is allowed), show a **"Sign in with a passkey"** button above the
   password field. Click → `begin-authentication` → `navigator.credentials.get`
   with the returned options → `finish-authentication` with the result → the
   Set-Cookie establishes the session (the browser stores it; just re-run
   `show()`). On `NotAllowedError` (user cancelled) show a gentle inline
   note, no alarm. On other failures show the error and fall back to the
   password field being usable.
2. **Settings → "Passkeys" card** (above the security log): list enrolled
   credentials (name, last used), an "Add a passkey" button
   (`begin-registration` → `navigator.credentials.create` →
   `finish-registration`, prompt for a label like "Sam's phone"), and a
   revoke button per credential. The raw id is never shown; the label is
   what the parent sees.
3. **Recovery notice**: one plain line in the card — "Your password still
   works as a backup. If you lose every device, use it to sign in and add a
   passkey again."
4. Feature-detect: if `!window.PublicKeyCredential` (very old browser /
   some Android WebViews), hide the passkey button and show a dim line
   "Passkeys need a recent browser" — the password path must remain fully
   usable at all times.

## Files in scope

- public/admin.html
- server.js (ONLY the `webauthn: true/false` signal on `GET /api/admin/me`)

## Files explicitly out of scope

- webauthn.test.js, hardening.test.js, dbperms.test.js, server.test.js,
  docs/*, compose.yaml, Dockerfile, any other server route

## Acceptance

```sh
node --test
grep -q "navigator.credentials.get" public/admin.html
grep -q "navigator.credentials.create" public/admin.html
grep -q "PublicKeyCredential" public/admin.html   # feature detection
grep -q "Sign in with a passkey" public/admin.html
grep -q "Passkeys" public/admin.html
grep -qi "backup" public/admin.html                # recovery notice
# the me-signal is the only server change:
node -e "
const s = require('node:fs').readFileSync('server.js','utf8');
if (!/webauthn:\s*(true|false|!!|count)/.test(s)) throw new Error('me endpoint must expose a webauthn signal');
// no new route paths may have been added by this task beyond 0015's set:
const routes = [...s.matchAll(/p === '([^']+)'/g)].map(m=>m[1]);
const allowed = new Set(['/api/admin/me','/api/admin/login','/api/admin/setup','/api/admin/logout','/api/admin/password','/api/admin/token','/api/admin/token/rotate','/api/admin/security','/api/admin/sessions','/api/admin/kiosk-devices','/api/admin/api-keys','/api/admin/webauthn/begin-registration','/api/admin/webauthn/finish-registration','/api/admin/webauthn/begin-authentication','/api/admin/webauthn/finish-authentication','/api/admin/webauthn/credentials','/api/admin/export']);
const extra = routes.filter(r => !allowed.has(r) && !r.includes('/api/admin/profile') && !r.includes('/api/admin/config') && !r.includes('/api/admin/today') && !r.includes('/api/admin/identity'));
// (the above allow-list is a sanity net; the real guard is node --test staying green)
console.log('me-signal-ok');
"
```

## Stop and ask if

- 0015's routes are absent (its merge did not land) — do not stub them
- `GET /api/admin/me` already has a different shape that makes the
  `webauthn` signal awkward — describe it and stop rather than changing the
  contract two tasks deep

## Notes for the agent

- The kiosk page (`public/index.html`) is untouched — passkeys are a parent
  console thing, never a kiosk thing.
- `credentials.create`/`.get` options must be passed through from the server
  response VERBATIM (the server is already base64url where the spec wants
  it) — if the browser rejects an option, the bug is in 0015's encoding;
  note it, don't paper over it with a transform here.
