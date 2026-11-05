---
id: 0005
title: XFF trust model (private peers only) + rate-limit map hygiene
plan_ref: H
provider: evobox
sandbox: node
risk: medium
max_iterations: 3
estimated_minutes: 30
---

## Goal

`clientIp(req)` in `server.js` trusts `X-Forwarded-For` unconditionally. That
is wrong in two ways: (1) with the app exposed directly to the internet, an
attacker rotates the XFF header to get a fresh rate-limit bucket per request
(the kiosk limit is per-IP, so the limiter is bypassable — a DoS-of-the-
limiter, not an auth bypass, but real); (2) behind a proxy that sets XFF
correctly, we WANT the forwarded IP. The rule to implement: **trust the first
`X-Forwarded-For` value only when the direct socket peer is a private or
loopback address** (127.0.0.0/8, ::1, ::ffff:127.0.0.1, 10.0.0.0/8,
172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 for Tailscale, fc00::/7). From
any other peer, ignore XFF entirely and use the socket address. No env var —
this default is correct for both direct exposure and proxying.

Also harden the limiter itself: `limits` and `lockouts` are Maps keyed per IP
that grow unbounded (keys are never evicted). Add a sweep: whenever
`limits.size > 4096`, delete entries whose arrays are empty/expired (and
same for `lockouts` when `until` is past). Keep it O(size) and cheap.

Export `clientIp` and the private-address helper via `module.exports` so the
tests can unit-test them with fake `req` objects (no network).

## Files in scope

- server.js
- server.test.js

## Files explicitly out of scope

- public/*, docs/*, Dockerfile, compose.yaml, hardening.test.js
  (the SECURE_COOKIES process must not change)

## Acceptance

```sh
node --test
# unit behavior of the trust model with fake req objects:
node -e "
const { clientIp, isPrivateAddr } = require('./server.js');
const fake = (peer, xff) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: peer } });
if (clientIp(fake('127.0.0.1', '203.0.113.9')) !== '203.0.113.9') throw new Error('private peer must trust xff');
if (clientIp(fake('203.0.113.9', '10.0.0.1')) !== '203.0.113.9') throw new Error('public peer must ignore xff');
if (clientIp(fake('100.86.0.5', '1.2.3.4')) !== '1.2.3.4') throw new Error('tailscale peer must trust xff');
if (clientIp(fake('::ffff:127.0.0.1', '8.8.4.4')) !== '8.8.4.4') throw new Error('ipv4-mapped loopback must trust xff');
if (!isPrivateAddr('10.1.2.3')) throw new Error('10/8 private');
if (!isPrivateAddr('172.16.0.1')) throw new Error('172.16/12 private');
if (isPrivateAddr('8.8.8.8')) throw new Error('8.8.8.8 is not private');
console.log('xff-trust-ok');
" | grep -q xff-trust-ok
grep -q "4096" server.js
```

## Stop and ask if

- the sweep needs to run on a timer (setInterval) rather than inline — that
  changes process lifetime behavior and I want the inline-on-grow approach
  first
- you find the kiosk/admin limit keys should be namespaced differently to
  make the sweep safe

## Notes for the agent

- `node --test` runs BOTH `server.test.js` and `hardening.test.js` — the
  existing suite must stay green; it exercises clientIp via the limiters.
- The existing "login lockout" tests drive the limiter from 127.0.0.1, so
  keep loopback peers trusting (or absent) XFF exactly as the tests assume.
