---
id: 0015
title: WebAuthn/passkey server endpoints (credentials table, register, sign-in)
plan_ref: P
provider: evobox
sandbox: node
risk: high
max_iterations: 5
estimated_minutes: 60
thinking: high
---

## Goal

Passkey sign-in for the parent console, server side only. **Read
`.autopilot/research/0004/output.md` (or `docs/research/webauthn.md`)
FIRST — the attestation policy, the CBOR decision, the COSE key handling,
and the protocol build plan are binding for this task. If that file is
missing, STOP and ask.** Implement exactly what the research recommends; do
not independently pick a CBOR strategy.

Shape (following `docs/self-service.md`): passkeys are a second way to
obtain the SAME session cookie the password path produces. The password
stays as the recovery path.

- New table `credentials (id, name, user_handle, public_key BLOB,
  sign_count, rp_id, origin, aaid BLOB, created_at, last_used_at,
  revoked_at)`. Single `user_handle` = `"admin"` for now.
- Endpoints (the register/authenticate pairs use a short-lived in-memory
  challenge, TTL 60s, one outstanding per browser tab/session):
  - `GET /api/admin/webauthn/begin-registration` → a WebAuthn
    `PublicKeyCredentialCreationOptions` JSON (challenge, rp, user, pubKeyCredParams
    for the key types the research approved, attestation per policy,
    authenticatorSelection per the household UV/UP recommendation).
  - `POST /api/admin/webauthn/finish-registration` (admin-gated) with the
    serialized `PublicKeyCredential` → verify per the research policy, store
    the credential (COSE public key bytes, signCount, aaid), return the
    credential record (id base64url, name). Audit `webauthn_enroll`.
  - `GET /api/admin/webauthn/begin-authentication` (NOT admin-gated — it is
    the login) → `PublicKeyCredentialRequestOptions` (challenge, rpId,
    allowCredentials = enrolled non-revoked ids).
  - `POST /api/admin/webauthn/finish-authentication` (NOT admin-gated) →
    verify signature + signCount, on success issue `newSession()` cookie
    (exactly like login) and audit `webauthn_signin`; on failure audit
    `webauthn_fail` and 401.
  - `GET /api/admin/webauthn/credentials` and
    `DELETE /api/admin/webauthn/credentials/:id` (admin-gated, audited
    `webauthn_revoke`) for the UI in 0016.
- The `?` — keep the existing lockout/rate-limit behavior on the PASSWORD
  path only; the passkey path has no secret to brute force, but DO rate-limit
  `finish-authentication` to 10/min/IP (it is an open endpoint) and log
  failures.
- **Verification must be real**: signature verify with node:crypto per the
  research's COSE notes, signCount monotonicity check (a lower counter than
  stored = clone/rollback → reject + audit `webauthn_counter_rollback`),
  origin check against `SECURE_COOKIES`/the request origin, challenge
  single-use (delete on use AND on expiry sweep).

## Files in scope

- server.js
- webauthn.test.js (new)

## Files explicitly out of scope

- public/* (the UI is 0016), docs/* (a docs/api.md entry is a follow-up —
  note it in your hand-back), hardening.test.js, dbperms.test.js,
  server.test.js (do not disturb), compose.yaml, Dockerfile

## Acceptance

```sh
node --test
node -e "
// Round-trip test with a REAL ES256 keypair and a hand-built assertion,
// proving the verify path works end to end without a browser.
process.env.DB_PATH = ':memory:';
process.env.SETUP_TOKEN = 'f'.repeat(64);
const { server, db } = require('./server.js');
const crypto = require('node:crypto');
server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const origin = new URL(base).origin;
  const setup = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', token: 'f'.repeat(64) }) });
  const ck = setup.headers.get('set-cookie').split(';')[0];
  const H = { cookie: ck, 'content-type': 'application/json' };
  const begin = await (await fetch(base + '/api/admin/webauthn/begin-registration', { headers: H })).json();
  if (!begin.challenge) throw new Error('begin-registration must return a challenge');
  // build a credential: ES256 keypair, COSE public key, attestation 'none'
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  // (task implementer: use the project's own COSE/CBOR helpers to build a
  //  valid attestation object + authenticatorData for the begin options,
  //  then a valid assertion signing the begin-authentication challenge.)
  // Acceptance only asserts the SURFACE + one real verify path:
  const bad = await fetch(base + '/api/admin/webauthn/finish-authentication', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response: { signature: 'aWFtZm9yZ2Vk' } }) });
  if (bad.status !== 401) throw new Error('garbage assertion must 401, got ' + bad.status);
  const sec = await (await fetch(base + '/api/admin/security', { headers: H })).json();
  if (!sec.events.some(e => e.kind === 'webauthn_fail')) throw new Error('failed assertion must audit webauthn_fail');
  server.close();
  console.log('webauthn-surface-ok');
});
" | grep -q webauthn-surface-ok
# the test file must exercise a REAL positive verification path:
grep -q "finish-registration\|finish_authentication\|finishAuthentication" webauthn.test.js
grep -qiE "verify|signature" webauthn.test.js
grep -q "sign_count\|signCount" server.js
```

## Stop and ask if

- the research's CBOR decision requires an npm dependency (a pure-JS CBOR
  lib) — that is a zero-dep exception and a HUMAN call; stop and present
  the tradeoff rather than adding a dependency or hand-rolling a parser the
  research explicitly rejected
- node:crypto cannot verify one of the key types the research says we must
  support (e.g. EdDSA import) — narrow to the supported types and note it
- origin checking is ambiguous when `SECURE_COOKIES` is off (http) — default
  to comparing against the request `Origin` header's host and the `Host`
  header, and note the assumption

## Notes for the agent

- This is crypto on a child-data system: when in doubt between two
  verification behaviors, reject. A passkey that sometimes verifies loose is
  worse than one that is strict.
- Keep the password path byte-for-byte unchanged (its tests must still pass
  untouched).
- If you implement a COSE/CBOR helper, put it in server.js (no new module
  file unless 0016's UI genuinely needs it exported) and unit-test the
  helper with known test vectors in webauthn.test.js.
