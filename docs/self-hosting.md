# Self-hosting

One process, one file. Everything you need to run a board.

## Prerequisites

- A machine you can reach from the kiosk: a Raspberry Pi, a home server, a
  VPS, or a PaaS. 512 MB of RAM is more than enough.
- Docker (recommended), or Node ≥ 22.13.

## Docker Compose (recommended)

```sh
git clone https://github.com/arbog/behavior-dashboard
cd behavior-dashboard
docker compose up -d
```

- Binds `127.0.0.1:8080` by default. Reach the console from that machine with
  `http://127.0.0.1:8080/admin`. To reach it from the LAN, change the port line
  to `"8080:3000"`.
- Data lives in the `board-data` volume (`/data/board.db` inside).
- `docker compose pull && docker compose up -d` upgrades.

### Non-interactive provisioning

For a PaaS or an unattended install, set the credentials in env — they only
take effect on the **first** run:

```yaml
environment:
  - TZ=America/Los_Angeles
  - ADMIN_PASSWORD=${ADMIN_PASSWORD}
  - KIOSK_TOKEN=${KIOSK_TOKEN}   # optional; else one is generated
  - SECURE_COOKIES=1             # set ONLY when served over TLS (PaaS, tunnel)
  - SETUP_TOKEN=${SETUP_TOKEN}   # optional; see "First run" below
```

### First run and the setup token

A fresh board refuses to be claimed without a **one-time setup token** —
otherwise whoever reaches a new URL first becomes the admin. Two ways to get
it:

- **Interactive (self-host):** the server prints it once on first boot:
  `setup token: <64 hex>` in the container log (`docker compose logs board`).
  Paste it into the setup screen.
- **Non-interactive (PaaS / unattended):** set `SETUP_TOKEN` in the
  environment before the first boot; the log then only says
  `setup token provided via SETUP_TOKEN env`. If you also set
  `ADMIN_PASSWORD`, no token is issued at all — the board is configured at
  boot and setup is permanently closed.

The token is single-use: a successful setup deletes it, and a board can never
be claimed twice.

`ADMIN_PASSWORD` skips the setup screen; `KIOSK_TOKEN` seeds the kiosk code.
After first run, the database is the source of truth (change the password in
the console; rotating the kiosk code invalidates the env value).
`SECURE_COOKIES=1` adds the `Secure` cookie flag and HSTS — PaaS templates set
it for you; a plain-HTTP LAN deploy must leave it off.

## Bare Node

```sh
node server.js        # or: npm start
```

Data goes to `./data/board.db` (override with `DB_PATH`). Port 3000
(override with `PORT`). No install step — there are no dependencies.

## Exposure

| Situation | What to do |
|---|---|
| Kiosk and phone are on the LAN, you rarely need it away | Bind the port to the LAN (`"8080:3000"` or `0.0.0.0`) with a strong admin password + kiosk code. |
| A parent is often away (school runs, work) | Put TLS in front. Options, easiest first: **Cloudflare Tunnel** (no open ports, free, works with the app's `X-Forwarded-For` handling), **Caddy** auto-TLS, or your router's reverse proxy. Set `SECURE_COOKIES=1` once TLS is in front — that is what earns you HSTS and Secure cookies. |
| Full internet exposure, no reverse proxy | Don't. The app is private but it is not a hardened public service; get TLS and strong credentials first. |

The app trusts `X-Forwarded-For` for per-IP rate limiting when it is present —
which is why a reverse proxy should strip/replace it (most do by default).

## The kiosk appliance

The kiosk is a browser tab in kiosk mode that points at `/?token=<code>`:

- **Chromium/Chrome (Linux, Android)**: `chromium --kiosk --no-first-run "http://HOST/?token=<code>"`. The code is saved on the device after first unlock, so a bare `http://HOST/` works from then on.
- **iPad**: Safari → Add to Home Screen → full-screen kiosk; or an MDM kiosk app.
- **Smart TV (webOS/Tizen)**: point the browser at the URL once; the token persists in its storage.

Screen wake-lock is handled in-app; the page refreshes every 8 seconds.

## Backup & restore

Stop the app, copy `board.db` (and `-wal`/`-shm` if present), start it. Or,
without stopping: `sqlite3 board.db ".backup /tmp/backup.db"`. Restore = copy
the file back into `/data` (or `./data`), restart. The schema is created and
migrated automatically on boot; there are no other moving parts.

## Uninstall

Delete the container and the `board-data` volume. That is the whole footprint.

## Your data, your law

When you self-host, you run the board on your own machine for your own
family. You are the one who decides what is stored and who can see it — the
duties about children's data (COPPA, state privacy laws) fall on operators of
online services, and a family's personal, non-commercial instance is not one.
The software still protects you: data stays on your machine, there is a
retention control, and there is a delete-everything control. If you give
anyone else (a relative, a therapist, a provider) access or copies, that
sharing is your decision under your own obligations. We publish the tool; we
make no claims about your use of it, and we cannot see, back up, or recover
what you run.

The board keeps a consent record — your acknowledgment, with a timestamp —
which survives even a full wipe, because a deletion record is the one thing a
deletion request must leave behind.

## Encryption at rest

Set `BD_PASSPHRASE` (8+ characters) and the board encrypts everything at
rest: the data directory holds one encrypted blob (`board.enc`), the working
copy lives on tmpfs when the host offers it, and the blob re-encrypts every
30 seconds and at clean shutdown. A stolen disk yields a useless file.

- **The passphrase is the only key.** There is no recovery code and no
  backdoor — a lost passphrase means lost data, on purpose. Both parents
  should know it.
- **Backup = copy `board.enc`.** It is encrypted and self-contained; restore
  = put it back and supply the passphrase. The JSON export remains the
  human-readable escape hatch.
- **Crash honesty:** a hard crash loses at most the re-encrypt cadence of
  writes — unless the working copy survived, in which case the next boot
  recovers it (the boot says "recovered unflushed state" when it does).
- **Migrating an older install:** boot with `BD_PASSPHRASE` set next to an
  existing plaintext `board.db` and it is encrypted, verified, and the
  plaintext removed — once, at first boot.
- If you can, run the data directory on an encrypted filesystem too — that
  protects the working copy and the tmpfs file as well. Encryption here
  covers at-rest only; a live process (and a compromised host) can read data,
  as with any database.
