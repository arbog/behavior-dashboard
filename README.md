# KindBoard

*(the code stays `behavior-dashboard`; the product is KindBoard — decided 2026-11-05, see docs/research/naming.md)*

A self-hosted behavior board for one family: **the kiosk your child taps, and the
console your protocol runs on**, in one small app that lives on your own server.

It is built by a parent running an ABA-style behavior program at home, for the
autism/ABA community that does the same. The board turns a paper packet into a
living system: a visual daily schedule with a token economy, a "battery" for
regulation state, check-ins that track what actually precedes hard moments, a
one-tap "behavior just happened" procedure, and the patterns that emerge from
the record.

**One instance, one child, your data.** No accounts, no telemetry, no cloud —
it is a single SQLite file you own. Zero runtime dependencies: Node (≥ 22.13)
standard library only, which is also why the Docker image is small and boring.

> ⚠️ This is a family tool, not a medical or behavioral-treatment device. It
> records and visualizes *your* protocol; it does not prescribe one. If a
> board, schedule, or token economy is part of a child's program, the people
> running that program decide how it is set up.

**Why this is free, how it is funded, and what we will not do with your
child's data: [VALUES.md](VALUES.md).**

## The two surfaces

| Surface | Who uses it | What it does |
|---|---|---|
| **Kiosk** (`/`) | The child | Today's schedule with finish/rules marks, "I am working for…", the battery, coping tools, the rules, what's paused, the week ahead. Taps only — no login on the screen, just the board's **kiosk code**. |
| **Console** (`/admin`) | The parents | Score the day, run the protocol (check-ins, battery moves, the one-tap behavior procedure), log ABC events, plan days (trips, free-form Saturdays), edit every schedule/rule/tool/list, read the patterns, and manage the board's security. |

Both are one app, one process, one database. The kiosk and console agree
because they read the same state.

## Quickstart

Docker (recommended):

```sh
git clone https://github.com/arbog/behavior-dashboard
cd behavior-dashboard
docker compose up -d
```

Then:

1. Open `http://HOST:8080/admin` and create the console password (first run).
2. Copy the **kiosk code** from *Settings → Kiosk code*.
3. On the TV/iPad, open `http://HOST:8080/?token=<kiosk code>`. The device
   remembers it; every kiosk after that just opens the base URL.

Bare Node (no Docker):

```sh
npm start          # or: node server.js
```

Needs Node ≥ 22.13 (it uses `node:sqlite`). Data lands in `./data/board.db`.

See [docs/self-hosting.md](docs/self-hosting.md) for LAN vs. internet exposure,
TLS, PaaS templates, and kiosk appliance notes, and
[docs/security-model.md](docs/security-model.md) for what protects what.

## How it works

- **The week is a template; plans are the exceptions.** Each weekday maps to a
  *mode* (School Day, Weekend, Free Day, Trip Day — edit freely). A *day plan*
  ("Beach Day") overrides one date and shows up on the kiosk with its name.
  Plans never rewrite a day that already has marks.
- **Token economy.** Each activity earns a finish mark (✓/✗) and a rules mark
  (✓ / ⭐ turned-around / ✗). The day's reward minutes come from the mode's
  tiers: all-checks, one-X, two-plus-X. An X caps the day — the kiosk shows
  what is actually still on the table, not a fantasy projection.
- **The battery.** Five lines the child sees as bands ("Ready to go" →
  "Big feelings"). A parent removes a line when behavior happens and restores
  them as the child co-regulates. Every move is logged. The band names and
  wording are yours to edit (*Settings → Battery bands*).
- **Check-ins & risk.** Parents log 0–3 on a few drivers (hunger / boredom /
  house by default) which the board scores 0–100 and bands. The console
  keeps the clock: a check-in is "due" on your interval, and the patterns
  tab finds what is different in the two hours before a blowup.
- **The protocol, as buttons.** "If behaviors occur" is one tap: an ABC entry,
  a line off the battery, reinforcement paused, and the script to say out
  loud. Reinforcement only resumes after a check-in **and** a tool use — the
  kiosk and console both say exactly which one is missing. The wording of
  all of it (proactive steps, behavior steps, scripts) is editable under
  *Settings → Protocol*.

## Security, in one paragraph

The app is private by default and says so: the page shells are public (they
carry no data), the kiosk's **board data** requires the kiosk code, and the
console requires the admin password. Sessions are HttpOnly cookies; login is
rate-limited with a 15-minute lockout after five failures; changing the
password signs out every session; the kiosk code can be rotated any time from
the console, which signs every device out. Every security-relevant event —
logins good and bad, password changes, rotations, console writes with their
source IP — is kept in a bounded on-server audit log, shown in *Settings →
Security log*, next to when the kiosk code was last used and from where.
Over TLS, set `SECURE_COOKIES=1` for HSTS and Secure cookies. The whole model
is in [docs/security-model.md](docs/security-model.md).

## Roadmap

[docs/roadmap.md](docs/roadmap.md) — name and domain are still open, the
"click a button and it's deployed" story (PaaS templates, managed hosting)
is next, and so are multi-child boards, SSO, and i18n. The managed-hosting
plan — how we would run boards for families, the isolation story, the trust
model, and the privacy-law layer — is public in
[docs/managed.md](docs/managed.md).

## Contributing

MIT licensed. Issues and PRs welcome — the app is one file of engine
(`server.js`), two HTML files, and a test suite that exercises the whole HTTP
surface (`node --test`).
