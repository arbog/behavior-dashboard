# Security model

What protects what, and what you still have to do.

## The rule

**The page shells are public; the data is not.** `GET /` and `GET /admin`
return UI code. Every byte of board state — the schedule, the marks, the
battery, the ABC log, the patterns — sits behind a credential:

| Path | Credential | Notes |
|---|---|---|
| `/healthz` | none | Liveness + SQLite probe only. No board data. |
| `/` , `/admin` | none | Static UI shells. |
| `/api/today`, `/api/today/*` | **kiosk code** | Header `x-kiosk-token` or `?token=` query. Read *and* write (the taps). |
| `/api/admin/me` | none (state probe) | Answers `200 {setup:true}` on a fresh install, `401` otherwise — it leaks nothing else. |
| `/api/admin/login`, `/api/admin/setup` | password | Login is rate-limited; setup is a one-shot. |
| `/api/admin/*` (all the rest) | **admin session cookie** | Includes reading/rotating the kiosk code and changing the password. |

### Kiosk code

- 48 random hex chars, generated on first run (`KIOSK_TOKEN` env can seed it).
- Checked with a constant-time compare; wrong length fails fast.
- Rotating it (console → Settings → Kiosk code) instantly invalidates every
  device — the new code is shown once, on the console.
- Per-IP rate limit: 60 requests/minute on the kiosk API.

### Admin session

- Password is scrypt-hashed with a per-password salt; never stored or logged
  in cleartext. 8-character minimum enforced at setup and change.
- Session = 64 random bytes, stored only as its SHA-256, HttpOnly
  `SameSite=Strict` cookie, 30 days, invalidated on logout.
- Login: 10 attempts/minute/IP, then a **15-minute lockout after 5 failures**.
  (The lockout is in-memory: a restart clears it. That is deliberate — it
  stops credential stuffing, not a persistent attacker; the real controls are
  the password, TLS, and exposure below.)
- Admin API: 300 requests/minute/IP.

### Response headers

Every response carries `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'self'` (the app is fully self-contained:
no CDNs, no third-party scripts, no images from elsewhere),
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` (no clickjacking frame).

## What you still own

This app is single-tenant and has no network policy of its own — exposure is
the deployer's decision:

- **LAN only (default and recommended for most families).** Bind the port to
  your LAN and use a strong password and kiosk code. That is the whole story.
- **Internet exposure.** Only worth doing if a family member is away from the
  board all the time. Then: TLS in front (Caddy, nginx, Cloudflare Tunnel —
  see self-hosting.md), strong credentials, and note that the kiosk code is
  a bearer credential for *reads and taps*: anyone with it can see the day and
  mark items. Treat it like a password, and rotate it if it ever leaks.
- **Backups.** `/data` (one SQLite file + WAL) is the entire secret life of the
  board. It contains your child's behavioral record. Back it up like you back
  up anything with a minor's data in it; restore = stop the container, copy
  the file back, start it.

## Threat notes (things we deliberately did *not* do)

- **No multi-tenancy, no per-user data isolation** — one board per instance.
  Running several children = several instances (or see the roadmap).
- **No OIDC/SSO yet** — password + kiosk code is the whole auth surface.
  (On the roadmap.)
- **No account enumeration hardening** — `/admin` and `/` exist regardless of
  configuration; that is a constant, not a leak.
- **Kiosk writes are trusted once the code is presented** — the taps are what
  they are (finish/choice/tool). There is no per-tap confirmation, because the
  surface is a child's hand, not an account.
- **Timestamps are wall-clock local** — set `TZ` on the host; the analytics and
  the check-in due-clock are only as good as the clock.
