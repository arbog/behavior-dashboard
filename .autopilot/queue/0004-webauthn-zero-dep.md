---
id: 0004
title: Research — implementing WebAuthn/passkeys in zero-dep Node >=22
plan_ref: P
kind: research
provider: shadowbox
sandbox: research
risk: low
max_iterations: 3
estimated_minutes: 45
---

## Goal

We want passkey (WebAuthn) sign-in for the parent console (design in
`docs/self-service.md`): enrollment + assertion, one "admin" user,
platform authenticators (Face ID / Windows Hello / Touch ID) plus security
keys, with the SAME session cookie the password path produces today. The
app is Node ≥22, zero npm dependencies (`node:crypto` only). Determine
exactly what that requires and recommend a build plan.

Answer, with cited URLs (WebAuthn Level 2 / CTAP2 / COSE specs,
browser/OS docs, `node:crypto` docs):

1. **Attestation policy.** Can we safely run `attestation: none` (accept
   self-attestation) for a household console, or must we verify against a
   trust store (FIDO2 metadata / Apple/Google/MS attestation roots)? What do
   platform authenticators actually return by default on iOS/Android/
   Windows/macOS (Apple and Google platform authenticators typically use
   self-attestation; YubiKey etc. use packed with a root). Recommend the
   minimal sound policy and say precisely what we verify vs skip.
2. **The CBOR problem.** Authenticator data, attestation objects, and
   assertions are CBOR-encoded. `node:crypto` has no CBOR. Options: (a)
   hand-roll a *bounded* CBOR decoder — enumerate EXACTLY which CBOR types
   appear in WebAuthn structures we must parse (major types, lengths,
   definite-length only? any indefinite sequences? maps/bytes/text/uints),
   and whether a ~100–150 line decoder is realistic and safe; (b) accept one
   small pure-JS CBOR dependency (name a candidate, its size, license,
   maintenance status) as an explicit, documented exception to the
   zero-dep rule; (c) any Node built-in we are missing. Recommend one and
   justify it against the security surface (a parser is attack surface).
3. **`node:crypto` coverage for COSE keys.** For each key type we must
   accept (ES256, ES384, RS256, EdDSA/Ed25519), can `crypto.verify` /
   `KeyObject` / `createPublicKey` do signature verification from the raw
   COSE key bytes, and what exact conversion (JWK or DER) is needed? Flag
   any type where node:crypto is awkward (EdDSA key import).
4. **Protocol build plan.** Endpoints, challenge lifecycle (where stored,
   TTL), the register and authenticate request/response fields we must
   build/parse, `signCount` handling, `userHandle` (fixed "admin"),
   `rpId` (= the board's domain — note the domain is still TBD and what a
   domain change does to enrolled passkeys), and UV/UP flag choices for a
   household (recommend requiring UV for enrollment, UP for sign-in).
5. **Browser/UX reality.** Passkey on a phone, cross-device sync (Apple
   iCloud / Google Password Manager passkey sync), what a second parent's
   device does, and the recovery story (recovery codes vs re-enroll from a
   working device) — recommend the simple correct one.

Write to `.autopilot/research/0004/output.md` with sections `## Attestation
policy`, `## CBOR decision`, `## COSE key support`, `## Build plan`,
`## Browser/UX + recovery`, `## Open questions`. Cite URLs. This feeds
tasks 0015 (server) and 0016 (UI).

## Files in scope

- .autopilot/research/0004/output.md (new)

## Files explicitly out of scope

- every other file (research profile is read-only on tracked files)

## Acceptance

```sh
test -s .autopilot/research/0004/output.md
[ "$(wc -c < .autopilot/research/0004/output.md)" -gt 6000 ]
grep -q "## Attestation policy" .autopilot/research/0004/output.md
grep -q "## CBOR decision" .autopilot/research/0004/output.md
grep -q "## COSE key support" .autopilot/research/0004/output.md
grep -q "## Build plan" .autopilot/research/0004/output.md
grep -qi "self-attestation" .autopilot/research/0004/output.md
grep -qE "ES256|RS256|EdDSA" .autopilot/research/0004/output.md
[ "$(grep -c 'https://' .autopilot/research/0004/output.md)" -ge 8 ]
```

## Stop and ask if

- the CBOR decision forces a real npm dependency and the zero-dep rule is
  in tension with it — present the tradeoff and mark it a human decision,
  do NOT unilaterally pick "add the dep"
- a key type we must support is not cleanly verifiable with node:crypto
