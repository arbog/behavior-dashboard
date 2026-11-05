# Research 0004 — WebAuthn/passkeys in zero-dep Node ≥22

Research task 0004, executed in-session 2026-11-05. Feeds tasks 0015
(server) and 0016 (console UI). Design context: `docs/self-service.md` —
passkeys are a second way to obtain the same session cookie the password
path produces; the password stays as recovery; the kiosk code is untouched.

Facts verified on this machine (Node 22.23.3) with real keys rather than
assumed:

```
ES256  : generateKeyPairSync('ec',{namedCurve:'P-256'}) → export JWK → createPublicKey({format:'jwk'}) → verify  OK
Ed25519: raw 32-byte public key must be wrapped — SPKI DER prefix
         302a300506032b6570032100 + raw32 → createPublicKey({format:'der',type:'spki'})
         → crypto.verify(null, msg, key, sig)  OK      (a bare raw key is rejected)
```

## Attestation policy

Recommendation: **`attestation: "none"` + structural verification of the
authenticator data + always verify the credential's signature.** Do not
verify attestation certificate chains in v1. Store whatever `fmt` the
authenticator used (`none`, `packed`, `tpm`, `android-key`) plus the AAGUID
for display, and treat provenance as a judgement the parent makes by
enrolling on a device they trust.

Why this is sound for a household console:

- The security property we need is "only a credential created for *this* RP
  ID, on *this* origin, can sign in." That is enforced by (a) `rpIdHash`
  matching our domain in the authenticator data, (b) `origin` matching in
  `clientDataJSON`, and (c) the per-assertion signature check against the
  stored public key. Attestation adds "this authenticator is a certified
  model" — valuable for regulated fleets, not for a parent's phone.
- The real-world formats we would have to trust: **Windows Hello prefers
  TPM** attestation, **Android uses Android Key Attestation** (post-Android
  O), **Apple platform authenticators return `none`** (and browsers may strip
  attestation entirely when asked for none). A trust-store policy would
  mean shipping/curating FIDO2 metadata for all three vendors, and would
  *reject* perfectly good `none` credentials from iPhones — the most common
  device a parent has. Source (formats and their typical authenticators):
  https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/Attestation_and_Assertion ,
  format registry: https://www.iana.org/assignments/webauthn/webauthn.xhtml
- Ask for `none` explicitly so browsers that would otherwise withhold/redact
  attestation behave consistently.

Optional later hardening (not v1): if a family wants security-key-only
mode, verify `packed`/`tpm` chains against the FIDO Metadata Service and
require an AAGUID allowlist. Put the hook in the schema (we already store
`aaid`) so it can be turned on without a migration.

## CBOR decision

WebAuthn needs CBOR in exactly two places, and both are **small, bounded
structures**:

1. `attestationObject` (registration): a CBOR map with 3 keys — `fmt` (text),
   `attStmt` (map, ignored under `attestation: none`), `authData` (byte
   string).
2. The **COSE public key** inside `authData`'s credential public key field —
   a CBOR map of small integers and byte strings (ES256: `{1:2, 3:-7, -1:1,
   -2:x, -3:y}`; EdDSA: `{1:1, 3:-8, -1:6, -2:x}`; RS256: `{1:3, 3:-257,
   -1:n, -2:e}`).

Notably, the **assertion** path needs no CBOR at all: `authenticatorData`
and `signature` arrive as raw bytes from `navigator.credentials.get`, and
`clientDataJSON` is a JSON string. So CBOR is registration-time only.

The parser subset required is therefore: unsigned/negative ints, byte
strings, text strings, arrays, maps, and booleans/null, with the standard
1/2/4/8-byte length encodings, **definite lengths only** (WebAuthn does not
emit indefinite-length items). That is roughly 100–150 lines of
recursive-descent code.

**Recommendation: hand-roll the bounded decoder** (`decodeCbor(buf,
{maxDepth: 8, maxItems: 512, maxBytes: 1<<20})`), with the RFC 8949 test
vectors and the three real attestation shapes as fixtures. Justification:
it keeps the zero-dependency property (the reason the image is small and
the supply chain is empty), and the subset is small enough to review in one
sitting. A hardened parser must be defensive (no unbounded allocation, no
recursion without a depth cap) — that is the actual risk, and it is
mitigable in this size of code.

**Fallback if review judges the hand-rolled parser too risky:** accept one
pure-JS CBOR dependency as a documented zero-dep exception. Candidates seen:
`cbor-x` (fast, widely used, optional native addon — the native path breaks
"image = Node + our source", the pure-JS fallback still works) —
https://www.npmjs.com/package/cbor-x ; `cbor-js` (pure JS, tiny, older) —
no maintenance guarantee. This is a **human call** per the task's
Stop-and-ask: do not add a dependency unilaterally.

## COSE key support

Verified against node:crypto on this machine:

| COSE alg | WebAuthn name | node:crypto path | Status |
|---|---|---|---|
| -7 | ES256 (P-256) | COSE map → JWK `{kty:'EC', crv:'P-256', x, y}` → `createPublicKey({format:'jwk'})`; `verify('sha256', data, key, sig)` | **works** |
| -35 | ES384 (P-384) | same with `crv:'P-384'`, `verify('sha384', …)` | works (same code path) |
| -257 | RS256 | COSE `n`,`e` → JWK `{kty:'RSA', n, e}`; `verify('sha256', …)` | works (same code path) |
| -8 | EdDSA / Ed25519 | raw 32-byte key → SPKI DER prefix `302a300506032b6570032100` + key → `createPublicKey({format:'der', type:'spki'})`; `verify(null, …)` | **works, with the wrapper** |
| -36 | ES512 | P-521 | not needed; omit |

The signature we verify is over `authenticatorData || SHA-256(clientDataJSON)`
(ES256/RS256/EdDSA per spec), computed with the authenticator's key.

## Build plan

Endpoints (all in `server.js`, per task 0015):

```
GET  /api/admin/webauthn/begin-registration      (admin session)
POST /api/admin/webauthn/finish-registration     (admin session)
GET  /api/admin/webauthn/begin-authentication    (OPEN — it is the login)
POST /api/admin/webauthn/finish-authentication   (OPEN — issues the session)
GET  /api/admin/webauthn/credentials             (admin session)
DEL  /api/admin/webauthn/credentials/:id         (admin session)
```

Challenge lifecycle: 32 random bytes, stored in an in-memory Map
`challenge → {purpose, expires, userHandle}`, TTL 60 s, **single use**
(deleted on consume; a sweeper drops expired ones; cap ~100 outstanding to
bound memory). Registration is admin-gated, so its challenge is bound to the
session; authentication is open, so its challenge is unauthenticated by
nature (that is fine — it is a nonce, not a credential).

Registration verification:
`clientDataJSON.type === 'webauthn.create'`; `challenge` matches; `origin`
matches the request origin; parse `attestationObject` CBOR → `authData` →
`rpIdHash === sha256(rpId)`; flags: `UP` set, `AT` set, `UV` set (we ask
for `userVerification: 'required'` at enrollment); read the credential id +
COSE key; store `{id, name, user_handle:'admin', public_key COSE bytes,
sign_count, rp_id, origin, aaid, created_at}`.

Authentication verification: `clientDataJSON.type === 'webauthn.get'`;
challenge matches; origin matches; `authData.rpIdHash === sha256(rpId)`;
`UP` set; look up the credential by id; verify the signature;
**signCount check**: `new > stored` (strict) when `stored > 0`; if
`new === 0 && stored === 0` (authenticator does not implement a counter)
allow; if `new <= stored && stored > 0` → reject + audit
`webauthn_counter_rollback` (cloned authenticator). On success: update
`sign_count` + `last_used_at`, mint the normal session cookie, audit
`webauthn_signin`.

`rpId`: the board's registrable domain. **The name/domain is still
undecided (PLAN workstream N)** — the code must read it from one setting/env
(`BD_RP_ID`, default = the request's host without port) so a later domain
change is a config change plus re-enrollment, and the wizard/settings must
say plainly: "changing your board's domain signs out all passkeys."

`origin`: compare `clientDataJSON.origin` to the request `Origin` header
(browser) or derive from `X-Forwarded-Proto` + `Host` behind a proxy; allow
a configured `BD_EXPECTED_ORIGIN` for the managed tier.

UV/UP defaults: `authenticatorSelection: { userVerification: 'required',
residentKey: 'preferred', authenticatorAttachment: undefined }` at
enrollment (we want the biometric/PIN moment); at sign-in
`userVerification: 'preferred'` (do not hard-fail a platform that reports
UP-only; the signature check still binds the credential to the origin).

Rate limiting: `finish-authentication` is open → 10/min/IP (reuse the
existing `rateLimit`), plus the audit of failures.

## Browser/UX + recovery

- **Platform passkeys sync**: iCloud Keychain (iOS/macOS), Google Password
  Manager (Android/Chrome), Windows Hello (per-device) — the second parent
  enrolling on their own phone is the normal case; the `credentials` table is
  exactly that list.
- **Cross-device**: "sign in on this phone" via the OS's QR flow is handled
  by the platform; our job is `allowCredentials` + a `timeout` (~60 s) and a
  clear error message when the authenticator is cancelled
  (`NotAllowedError` → "cancelled, or no passkey on this device — use your
  password").
- **Recovery, recommended:** keep the password as the recovery path
  (unchanged from today), and when a passkey is enrolled show a one-time
  "you still have your password" confirmation. If *all* devices are lost and
  the password is forgotten, the only path is a fresh board (document it).
  Recovery codes are a v2 idea; the table has room for a second-factor
  recovery blob if we ever do it.
- **Feature detection**: `window.PublicKeyCredential` + optional
  `isUserVerifyingPlatformAuthenticatorAvailable()` to hide the button on
  browsers that cannot do passkeys; the password path remains fully usable.

## Open questions

1. **CBOR: hand-rolled vs one dependency** — the human call above.
2. Does the board's eventual domain sit at the apex (`example.org`) or a
   subdomain — and if we later support custom domains for the managed tier,
   each domain is a separate `rpId` with separate credentials (multi-tenant
   passkey plan needed before managed launch).
3. Should sign-in require UV (`'required'`) rather than `'preferred'`? The
   trade is Windows Hello PIN users vs. the extra assurance. Recommend
   `'required'` at enrollment, `'preferred'` at sign-in, revisit after real
   device testing.
4. Attestation verification (FIDO MDS) for a "security key only" mode —
   post-v1.
5. Multi-user (`userHandle` is a constant `'admin'` today): when named users
   arrive (PLAN), credentials key on the real user handle — schema already
   has the column.
