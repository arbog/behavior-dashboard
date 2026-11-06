# API reference

The board's HTTP API. Everything a family or an automation needs, in one
page. **Keep in sync with `server.js`** — CI checks that every route path
handled by the server appears here.

Base URL: your board's origin (e.g. `https://board.example`).
All bodies are JSON; all responses are JSON unless noted.
Timestamps are the server's local wall clock (`YYYY-MM-DD HH:MM:SS`).

## Authentication

| Surface | Credential | How |
|---|---|---|
| Kiosk data (`/api/today*`) | **kiosk code** (per device) | Header `x-kiosk-token: <48 hex>`; `?token=` is accepted **only** on the initial `GET /api/today` |
| Console API (`/api/admin/*`) | **admin session** | `bd_session` HttpOnly cookie from login/setup |
| Console API (automation) | **API key** | Header `Authorization: Bearer bdb_<48hex>` or `x-api-key: bdb_<48hex>` |

An API key acts as the admin (its writes are attributed `api:<name>` in the
audit). Keys cannot reach the kiosk surface. The kiosk code cannot reach the
console. Errors are `{ "error": "message" }`.

**Capabilities (0013).** Every board keeps a picture of the day — schedule,
plans, choices. Seven parts can be switched off by the board profile: `tools`,
`rewards`, `battery`, `rules`, `abc`, `checkins`, `pause`. An endpoint whose
capability is off answers `404` (`"that part of the board is switched off in
this profile"`), and payloads omit its data (the kiosk payload carries the
whole flag set as `caps`; the console config carries `profile`).

## Open (no credential)

| Method & path | Purpose | Response |
|---|---|---|
| `GET /healthz` | liveness + SQLite probe | `{ ok, db, version, encrypted }` — `encrypted` says whether the store is the encrypted blob (BD_PASSPHRASE) or the plaintext file |
| `GET /` , `GET /admin` | page shells (no data) | HTML |
| `GET /api/admin/me` | state probe for the console UI | `200 {setup, setup_token, child_name}` (configured+authed) or `401 {setup}` |

## Kiosk API (kiosk code)

| Method & path | Purpose |
|---|---|
| `GET /api/today` | today's board for the kiosk (`?token=` is accepted only on this initial load) |
| `POST /api/today/choice` | the child's tap: `{label}` — records the reward choice |
| `POST /api/today/request` | the child's tap **as a request** (communication profile only, else 404): `{label}` must be a button on the board → logged for the parents, optionally pushed to `BD_WEBHOOK_URL` |
| `POST /api/today/checkin` | the child's own worry scale (when check-ins are on): `{level: 1–5}`, stored `by='kiosk'` |

## Setup & session (before there is a session)

| Method & path | Auth | Body | Response |
|---|---|---|---|
| `POST /api/admin/setup` | **setup token** (printed once at first boot, or `SETUP_TOKEN` env) | `{token, password, child_name?}` | `200` + Set-Cookie; `403` wrong token; `409` already configured |
| `POST /api/admin/login` | password | `{password}` | `200` + Set-Cookie; `401` wrong; `423` locked (5 failures → 15 min); `429` rate limited |
| `POST /api/admin/logout` | session | — | `200`, clears the cookie |

## Console API (session or API key)

Kiosk & board data:

| Method & path | Purpose |
|---|---|
| `GET /api/admin/config` | everything the console renders: modes (+items), weekdays, override, choices, abc_options, regulation, calendar, plans, identity, rewards, profile |
| `GET /api/admin/today` | today's board (same shape the kiosk sees) |
| `PUT /api/admin/today` | `{working_for}` — set what today's reward is |
| `POST /api/admin/today/reset` | rebuild today from its mode (clears marks) |
| `PATCH /api/admin/day-items/:id` | `{finished?: 0/1/null, rules?: check/turnaround/x/null, rule_id?}` |
| `GET /api/admin/history` | last 60 days with reward math |
| `PUT /api/admin/override` | `{mode_id}` for today only; `null` clears |
| `PUT /api/admin/weekdays` | `{0..6: mode_id}` weekly template |
| `POST /api/admin/modes` , `PUT /api/admin/modes/:id`, `DELETE /api/admin/modes/:id` | schedule templates |
| `PUT /api/admin/choices` | `{choices: [{icon,label}]}` (≥1) |
| `PUT /api/admin/rules` , `PUT /api/admin/tools` | `{rules/tools: [{id?, label/title, body?, icon}]}` |
| `PUT /api/admin/abc-options` | `{A:[], B:[], C:[]}` |
| `GET /api/admin/calendar?days=N` , `PUT /api/admin/plans/:date`, `DELETE /api/admin/plans/:date` | day plans (plan/trip/free/special + label) |
| `POST /api/admin/free-weekday` | `{dow, mode}` — map a weekday to the free-form template |

Regulation & protocol:

| Method & path | Purpose |
|---|---|
| `GET /api/admin/regulation` | battery + pause + check-in clock + risk + protocol copy |
| `POST /api/admin/battery` | `{delta}` or `{lines}` — move the battery |
| `POST /api/admin/behavior` | the one-tap procedure: `{rule_id?, behaviors, antecedents, consequences?, severity?, note?}` → ABC entry + battery −1 + pause + script |
| `POST /api/admin/checkins` | `{hunger, boredom, house, battery?, note?}` |
| `POST /api/admin/pause` / `POST /api/admin/resume` | `{reason, minutes?}` / `{restore}` |
| `GET /api/admin/risk?days=N` | the patterns bundle (timeline, by-hour, leading indicators, combos) |
| `GET /api/admin/abc?days=N` , `POST /api/admin/abc`, `DELETE /api/admin/abc/:id` | ABC log + summary |

Identity & copy (what the family words):

| Method & path | Purpose |
|---|---|
| `PUT /api/admin/identity` | `{child_name}` |
| `PUT /api/admin/bands` | `{bands: [{name,note,color} ×4]}` battery band wording |
| `PUT /api/admin/rewards` | `{lines: [...]}` the kiosk's how-it-works strip |
| `PUT /api/admin/protocol` | `{proactive[], behavior[], hold, script_rule, script, checkin_minutes}` |
| `PUT /api/admin/profile` | `{id}` switches the capability preset (resets the flags); `{capabilities}` refines them (`{rules:false, …}`) — flags live on every config + kiosk payload as `profile` / `caps` |

Linked accounts (OAuth — a third way to obtain the same admin session; see `docs/integrations.md` for the trust rules — linking is parent-only, sign-in requires an already-linked identity):

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/admin/oauth/providers` | open | which providers are configured (`{providers: ['google', …]}`) |
| `GET /api/admin/oauth/begin?provider=…` | open | `{url, state}` — the provider's authorize URL with a single-use state |
| `GET /api/admin/oauth/google/callback` | open | the code exchange → 302 back to `/admin` (`?oauth=linked` / `?oauth=…reason`); a sign-in sets the session cookie |
| `POST /api/admin/oauth/apple/callback` | open | Apple's `form_post` dialect (`id_token` + `state` in the form body) — same outcomes |
| `GET /api/admin/oauth/identities` | session | linked identities (provider, email, last used) |
| `DELETE /api/admin/oauth/identities/:id` | session | unlink — the provider can no longer sign in |

Passkeys (WebAuthn — a second way to mint the same admin session; the password stays as recovery):

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/admin/webauthn/begin-registration` | session | `PublicKeyCredential` options (`challenge`, `rpId`, `user`, `pubKeyCredParams`) |
| `POST /api/admin/webauthn/finish-registration` | session | `{challenge, name, response}` → `{id, name}` — attestation verified structurally (`attestation: none`) |
| `GET /api/admin/webauthn/begin-authentication` | open | `{challenge, rpId}` — 404 until a passkey exists |
| `POST /api/admin/webauthn/finish-authentication` | open | `{challenge, id, response}` → `200` + Set-Cookie; signature + sign-count checked, 10/min/IP |
| `GET /api/admin/webauthn/credentials` | session | enrolled passkeys (no key material) + the board's `rp_id` |
| `DELETE /api/admin/webauthn/credentials/:id` | session | remove a passkey |

Changing the board's domain (or `BD_RP_ID`) invalidates every passkey — a config change plus re-enrollment.

Security & data:

| Method & path | Purpose |
|---|---|
| `POST /api/admin/password` | `{current, next}` — changes it and signs out every session |
| `GET /api/admin/sessions` | live sessions (`sid`, created, last seen, `current`) |
| `DELETE /api/admin/sessions/:sid` | revoke one session |
| `DELETE /api/admin/sessions` | revoke all except the caller |
| `GET /api/admin/kiosk-devices` | devices (label, created, last used, revoked) |
| `POST /api/admin/kiosk-devices` | `{label}` → `{id, label, token}` — **token shown once** (max 8 active) |
| `DELETE /api/admin/kiosk-devices/:id` | revoke that device |
| `POST /api/admin/api-keys` | `{name}` → `{id, name, key}` — **key shown once** (max 5 active) |
| `GET /api/admin/api-keys` | keys (prefix only) |
| `DELETE /api/admin/api-keys/:id` | revoke a key |
| `GET /api/admin/export` | every table as one dated JSON attachment |
| `GET /api/admin/consent` | the consent artifact(s) — who acknowledged what, when |
| `PUT /api/admin/retention` | `{months}` 0–60 — how many months of raw events (ABC, battery, tools, check-ins) to keep; 0 keeps everything; prunes on save, hourly after |
| `POST /api/admin/wipe` | `{confirm: "DELETE EVERYTHING"}` — deletes every board data row, reseeds the neutral copy, signs out all other devices; keeps the login and the consent record |
| `GET /api/admin/requests` | the requests log (last 7 days, up to 200): what the child asked for + a tally |
| `GET /api/admin/security` | audit trail (last 50) + live kiosk devices + api keys + the retention setting |

Errors: `400` bad input, `401` no/wrong credential, `403` wrong token/password,
`404` unknown id or disabled capability, `423` login lockout, `429` rate
limited, `409` already-configured (setup) — plus `500` when the server says
so in its log.

## Rate limits (per source IP)

Kiosk API 60/min · Console API 300/min · login 10/min (lockout: 5 failures →
15 min). `X-Forwarded-For` is honoured only when the request arrives from a
private/loopback address — behind your reverse proxy it just works; exposed
directly, the header is ignored.
