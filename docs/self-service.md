# One-click self-host + passkey admin

**Status: sketch.** This is the shape of the solution, not the build. The
particulars — which PaaS, which attestation policy, whether a small CBOR
module is acceptable, the recovery-code count — are deliberately deferred.
Treat anything here as a contract to satisfy, not a spec to implement against.

## The goal

A parent who has never self-hosted gets to a working, private, HTTPS board in
roughly ten minutes, and signs in with a **passkey** (Face ID / Windows Hello
/ Touch ID / a security key) instead of inventing a password to remember and
defend. The board is already one container, one volume, no build step; what's
missing is (a) a zero-decision way to bring it up and (b) a credential that
can't be phished.

## The click — provisioning model

The "button" is the entry point. Three candidate shapes (choice deferred):

- **A. Install script.** `curl -fsSL … | sh` detects Docker, pulls the image,
  stands up a reverse proxy with automatic HTTPS, writes config, and prints
  `https://board.<their-domain>`. The most "self-hosted" story.
- **B. PaaS deploy button** (Render / Railway / Fly). The platform owns the
  container + TLS + URL. The most "click a button" story; this is also the
  front door for a later managed tier.
- **C. A `docker run` one-liner** with TLS documented. The least magic, the
  most reading.

Whichever it is, the click must satisfy one **contract**:

1. The board runs at a public **HTTPS** URL — certificates automatic, never
   the parent's job.
2. The app knows it is behind TLS, so `SECURE_COOKIES=1` is on (HSTS + Secure
   cookies, already built).
3. `/data` is a persistent volume (the board's whole state).
4. First run lands the parent on **passkey enrollment**, not a password form
   (below).

The app should be **identical** under A and B; the only thing that differs is
who terminates TLS and who owns the domain. That is the property to keep:
the board never assumes it is the TLS terminator — it just reads
`SECURE_COOKIES`.

## HTTPS — who terminates

- **Self-host (A/C):** a reverse proxy in front (Caddy is the low-effort
  choice: automatic Let's Encrypt, config is one line). The board listens on
  loopback or inside the container. `SECURE_COOKIES=1`.
- **PaaS (B):** the platform terminates. Same env var.
- Either way, `X-Forwarded-For` is set by a trusted terminator, which the
  app already uses for its per-IP limits.

## Passkey admin — the model

Today, the parent console is a scrypt password + HttpOnly session cookie +
lockout. The passkey is a **second, preferred way to get that same session** —
not a different kind of login, and not a change to the kiosk. The kiosk code
(the child's TV/iPad credential) stays exactly as it is.

The WebAuthn contract, in the two halves:

- **Enrollment** (first run, or from Settings): the console asks the browser
  for a passkey (`navigator.credentials.create` with a server-issued
  challenge); the device's authenticator makes one; the server verifies it and
  stores the credential. The parent now has one or more passkeys on their
  devices.
- **Sign-in** (every visit after): `navigator.credentials.get` — the
  authenticator signs a fresh server challenge; the server verifies the
  signature against the stored public key, checks the signature counter (a
  cloned authenticator can't advance it), and hands back **the same HttpOnly
  session cookie** the password path produces. From then on, nothing
  downstream changes.

**Recovery / fallback:** a lost phone must not lock the family out. The
password (or a set of printed recovery codes) remains as the back door.
Deferred: whether the password is retired to *recovery-only* or kept as a full
login.

**Why a passkey beats a password here:** it is phishing-resistant (the
credential only works on the exact origin, `https://board.example`, enforced by
the RP ID), there is no shared secret to steal or leak, and it works across
the parents' devices through the platform's passkey sync.

### How it composes with the existing security model

- The **session cookie stays the transport of "authenticated."** Passkeys and
  passwords are just two ways to obtain one. No new session machinery.
- The **kiosk code is untouched** — it is a device credential for the child's
  screen, a different thing from a parent's login.
- **Rate limits / lockout** keep guarding the password path (it still has a
  secret to guess). The passkey path has no secret, so it isn't subject to
  guessing; it *is* logged, like everything else, to `security_events`
  (`webauthn_enroll`, `webauthn_signin`, failures).
- **`admin_write` audit** is unchanged — a passkey session and a password
  session write the same audit rows.
- **Rotation of the kiosk code** stays admin-only, so it stays passkey-gated.

### Open questions (the deferred particulars)

- **Attestation verification depth:** full FIDO2 trusted-root, packed
  self-attestation, or `none`? Determines how much crypto the server must
  trust on its own.
- **The dependency question:** WebAuthn assertions/attestations are CBOR.
  `node:crypto` gives the signatures, but not a CBOR decoder. This is the one
  place the "zero npm dependencies" rule is genuinely tested — is one small,
  pure-JS CBOR module acceptable, or do we hand-roll the (bounded) subset?
- **User Verification / User Presence** requirements (must the fingerprint be
  present at sign-in, or is the device's presence enough?).
- **Household multi-user:** one passkey per parent, shared "admin," or real
  named users with the audit `by` field finally meaning something?
- **Cross-device recovery:** how many recovery codes, and do they live on the
  screen once (like the kiosk code) or printable?

## The new data

One table, sketched:

```
credentials (
  id, name,            -- "Sam's phone", "dad's MacBook"
  user_handle,         -- "admin" for now
  public_key,          -- the COSE key the device signed with
  sign_count,          -- monotonic; clone detection
  rp_id, origin,       -- the passkey's home (the board's domain)
  aaid,                -- authenticator model, if present
  created_at, last_used_at
)
```

Sessions, the password hash, and the kiosk code are all unchanged.

## What this sketch deliberately does NOT do

- No implementation, no new endpoints yet (they will be
  `/api/admin/webauthn/*`, behind the same session gate as the rest).
- No change to the kiosk.
- No PaaS button wiring — that is the roadmap's "click a button" item; this
  document is the shape that item has to satisfy.
- No attestation trust decisions — those are the deferred particulars above.
