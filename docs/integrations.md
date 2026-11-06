# Integrations: accounts and calendars

**Status: plan.** Apple/Google sign-in is built (this document describes it as
shipped); calendar integrations are specified and queued. Everything here
follows the two house rules: **zero npm dependencies** (the verification
crypto is ours, in `oauth.js`, reviewed line by line) and **no child data
leaves the board for any third party, ever** — which shapes every decision
below.

## Accounts: sign in with Apple / Google

The console is protected by a passkey and a password. Apple or Google sign-in
is a **third way to obtain the same session** — not a different account, and
not a substitute for the others. The kiosk code is untouched.

### What the provider learns, and what it does not

| The provider sees | The provider never sees |
|---|---|
| Your browser visiting their sign-in page | Your board's URL contents |
| Your identity as their account holder (email, or a private relay) | Your child's name, schedule, marks, ABC log, battery, notes — **any of it** |
| That your board's redirect URI exists | The fact that you run a behavior board |

No child data is disclosed to Apple or Google, so the third-party-disclosure
consent question (16 CFR 312.5(a)(2)) does not arise: the only personal data
that crosses is **your own** (the parent's). The email on the token is stored
solely so you can see which identity is linked in your console.

### The rules (all enforced in code)

1. **Linking is a parent act.** You link Apple or Google from the console,
   while signed in with a passkey or password. Sign-in is refused for anyone
   whose identity is not already linked.
2. **No account creation by OAuth.** There is one admin account per board;
   OAuth cannot mint or duplicate it, and an email match on the provider
   never links automatically (that would be the account-confusion attack).
3. **The token is verified, not trusted.** The ID token's signature is
   checked against the provider's published key set (JWKS, fetched and
   cached hourly), plus issuer, audience (it must name *your* board), and
   expiry. `alg=none` and every other algorithm-confusion classic are refused
   outright.
4. **The state is single-use.** Each sign-in attempt carries a one-time
   value; a reused one is dead on arrival.
5. **Unlink, and the door closes.** Unlinking from the console revokes the
   identity immediately — the provider cannot sign in again until a
   signed-in parent links it once more.

### Who can use it

The board needs a **public OAuth client registration per board** — Google
requires a verified domain, and Apple requires a registered redirect — so in
practice:

- **Managed tier:** configured by us per board (the client registration is
  part of the hosting). You get "Sign in with Apple/Google" out of the box.
- **Self-host:** possible if your board has a public domain and you register
  your own OAuth client with Google/Apple (`BD_OAUTH_GOOGLE_CLIENT_ID` /
  `CLIENT_SECRET` env; same for Apple). On a LAN-only board there is nothing
  to register against — passkeys and the password are the whole story, and
  that is fine.

The credential hierarchy stays: **passkey first** (phishing-proof, no shared
secret), password as the recovery path, OAuth as the convenience layer for
families who live in those ecosystems. Any of the three mints the same
HttpOnly session cookie, and every write lands in the same audit trail.

### Implementation notes (for the reviewers)

`oauth.js` holds the crypto: JWKS cache (hourly, per provider), ID-token
verification (RS256/ES256 only — the token's `alg` header is never trusted
beyond those two), issuer/audience/expiry checks, and the per-provider
dialect handling: Google runs the authorization-code exchange, Apple delivers
the finished token by `form_post` (their client_secret is their problem; the
`id_token` is what we verify). Endpoints: `/api/admin/oauth/{providers,begin,
google/callback,apple/callback,identities,identities/:id}` — the route-sync
test keeps `docs/api.md` honest about all of them.

## Calendars: the family's day, on the board

The board's calendar band already shows planned days (trip / free / special)
next to the weekly schedule. The natural integrations, in order of how much
trust they ask for:

### v1 — private iCal feeds (Apple Calendar AND Google Calendar, no OAuth)

Both Apple and Google can publish a **private iCal (ICS) feed URL** for any
calendar. The board fetches it on a schedule, parses the events, and shows
the upcoming ones on the kiosk's calendar band.

- **What the board gets:** the events on the calendar the family chose —
  appointments, therapy days, visits. Read-only.
- **What leaves the board:** nothing. The board *pulls* the feed; no tokens,
  no write access, no account linkage. The feed URL is a read-only secret —
  revoke it in the calendar app and the board simply stops seeing events.
- **Why this shape first:** it works for both Apple and Google with one
  integration, needs no OAuth consent screen, and cannot write anything back.
- **Honest limits:** the feed is a snapshot on a refresh cadence, not a live
  subscription; all-day and timed events render; the family can clear the
  integration from the console in one click.
- **Queued as `0024`.**

### v2 — native Google Calendar (OAuth, write-back)

Signing in with Google (the accounts feature above) can also authorize
calendar scope, letting the board *create* events from day plans ("Beach Day"
appears on the family's real calendar) and read details the ICS feed omits.

- This is the first feature where the board would hold an OAuth **access
  token with write scope** — a bigger trust step, gated by an explicit
  per-family consent screen, revocable from the console, and scoped to the
  one calendar the family picks.
- Built only after the managed tier's privacy notices cover it in plain
  words. Queued as `0025`.

### Apple native (EventKit / CalDAV)

Native Apple Calendar write access means CalDAV credentials or an Apple-only
API; the iCal feed covers the read case, and the write case waits for the
Google v2 pattern to prove itself. No date.

## What we will never do

- Ask a child (through the kiosk or otherwise) to authenticate with anything.
- Send child data to a provider to enrich, sync, or "improve" anything.
- Store a provider password. Tokens are scoped, revocable, and held in the
  encrypted store like everything else.
