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
| `/api/today`, `/api/today/*` | **kiosk code** | Header `x-kiosk-token` for everything; `?token=` query is honoured **only** on the initial `GET /api/today` (the deep-link affordance) so taps never put the credential in a URL that proxy logs can record. Read *and* write (the taps). |
| `/api/admin/me` | none (state probe) | Answers `200 {setup:true}` on a fresh install, `401` otherwise — it leaks nothing else. |
| `/api/admin/login`, `/api/admin/setup` | password | Login is rate-limited; setup is a one-shot. |
| `/api/admin/*` (all the rest) | **admin session cookie** | Includes reading/rotating the kiosk code and changing the password. |

### Kiosk code

- 48 random hex chars, generated on first run (`KIOSK_TOKEN` env can seed it).
- Checked with a constant-time compare; wrong length fails fast.
- Rotating it (console → Settings → Kiosk code) instantly invalidates every
  device — the new code is shown once, on the console.
- Per-IP rate limit: 60 requests/minute on the kiosk API.
- **Use telemetry:** the console shows when the code was last used and from
  which IP (Settings → Kiosk code → *Last used*), throttled to one note a
  minute. That is how you find out a stranger has the code.

### Admin session

- Password is scrypt-hashed with a per-password salt; never stored or logged
  in cleartext. 8-character minimum **plus a static blocklist of the most
  common passwords** enforced at setup and change.
- Session = 64 random bytes, stored only as its SHA-256, HttpOnly
  `SameSite=Strict` cookie, 30 days, invalidated on logout.
- **Changing the password signs out every session** — a console left open on a
  borrowed phone dies the moment the password moves.
- Login: 10 attempts/minute/IP, then a **15-minute lockout after 5 failures**.
  (The lockout is in-memory: a restart clears it. That is deliberate — it
  stops credential stuffing, not a persistent attacker; the real controls are
  the password, TLS, and exposure below.)
- Login timing is equalised when the board is unconfigured (a throwaway scrypt
  run), so `not configured` cannot be probed faster than `wrong password`.
- Admin API: 300 requests/minute/IP.

### Response headers

Every response carries `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'self'` (the app is fully self-contained:
no CDNs, no third-party scripts, no images from elsewhere),
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` (no clickjacking frame).

### TLS posture: `SECURE_COOKIES=1`

Set it when the app is served over TLS (PaaS, Cloudflare Tunnel, any reverse
proxy) — and leave it unset for plain-HTTP LAN deploys, where a `Secure`
cookie would break the console. It switches on two things:

- the session cookie gets the `Secure` attribute (sent only over HTTPS);
- responses carry `Strict-Transport-Security: max-age=31536000;
  includeSubDomains`.

The PaaS templates set it automatically; a self-run TLS deployment should add
it to the environment.

### Audit trail

`security_events` keeps the last 500 rows of: `setup`, `login_ok`,
`login_fail` (with the reason), `logout`, `password_change`,
`token_rotate`, `admin_write` (method + path + source IP),
`admin_rate_limited`, and the kiosk last-used note. The console shows the most
recent 50 under Settings → **Security log**. It is a record of who touched
what, when, and from where — including the attempts that did not get in.
An audit failure never breaks the app (the insert is wrapped and logged).

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
  (On the roadmap.) A passkey (WebAuthn) console login is sketched in
  [self-service.md](self-service.md): it would be a second way to obtain the
  same session, with the password kept as recovery — not a new auth surface.
- **The audit log is bounded and local** — 500 rows, on the box. Export is on
  the roadmap; today it is a window, not an archive.
- **No account enumeration hardening** — `/admin` and `/` exist regardless of
  configuration; that is a constant, not a leak.
- **Kiosk writes are trusted once the code is presented** — the taps are what
  they are (finish/choice/tool). There is no per-tap confirmation, because the
  surface is a child's hand, not an account.
- **Timestamps are wall-clock local** — set `TZ` on the host; the analytics and
  the check-in due-clock are only as good as the clock.
