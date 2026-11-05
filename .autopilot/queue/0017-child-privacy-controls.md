---
id: 0017
title: Child-privacy controls (consent gate, retention, delete-everything)
plan_ref: C
provider: evobox
sandbox: node
risk: high
max_iterations: 5
estimated_minutes: 50
thinking: high
---

## Goal

Implement the product-side controls the law research says the managed tier
(needing them) and self-hosters (benefiting from them) need. **Read
`.autopilot/research/0001/output.md` (or `docs/research/laws.md`) FIRST —
the "Managed-tier obligations" and "Self-host note" sections are the spec.
If that file is missing, STOP and ask.** Do not invent obligations the
research did not find; do not skip ones it did.

The three controls (each gated on what the research confirms as required or
recommended):

1. **Guardian consent gate.** On first run, BEFORE the setup token /
   password is accepted, the setup flow records an affirmative guardian
   confirmation: a checkbox "I am a parent or legal guardian of the child
   this board is for, and I consent to this family's data being stored on
   this board" that must be ticked to complete setup (stored as
   `settings.consent = { at, ip }`, audited `consent_recorded`). On the
   managed tier this is the verifiable-consent artifact; self-hosted it is
   the "you are the controller" acknowledgment. The research doc decides
   whether the wording must change per tier — it does not change the
   mechanism.
2. **Retention.** A `PUT /api/admin/retention { days }` (0 = keep forever,
   the default for self-host; the research's recommended default for managed)
   that, when > 0, purges `abc_events` and `check_ins` (and their
   correlated `battery_events`? — follow the research; default: the two
   time-series tables) older than N days, run on boot and daily
   (in-process timer, not a new process). Audited `retention_purge` with the
   row count.
3. **Delete-everything.** A `POST /api/admin/wipe` that requires the
   current password (or the setup token on a fresh board) typed in the
   request, then deletes ALL board data (every table's rows, keeps the
   schema), resets to a fresh-install state (new setup-token outstanding,
   no admin). Audited `wipe` BEFORE it wipes (log to stdout as well, since
   the audit table is itself wiped). A second confirmation string in the
   request body (the UI makes you type `DELETE`) guards against
   accidents.

UI (Settings, in `public/admin.html`): a "Privacy" card — the consent state
(when recorded, from which IP), the retention selector, and a
"Delete all data" danger zone (two-step: type DELETE). Keep it plain-spoken.

## Files in scope

- server.js
- server.test.js
- public/admin.html
- docs/security-model.md (a "Child privacy" subsection: consent, retention,
  wipe)

## Files explicitly out of scope

- hardening.test.js, dbperms.test.js, webauthn.test.js, docs/api.md (add the
  new routes there in a follow-up; note it), compose.yaml, Dockerfile,
  .github/*

## Acceptance

```sh
node --test
node -e "
process.env.DB_PATH = ':memory:';
process.env.SETUP_TOKEN = '0'.repeat(64);
const { server, db } = require('./server.js');
server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  // consent is required to complete setup:
  const noConsent = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', token: '0'.repeat(64) }) });
  if (noConsent.status === 200) throw new Error('setup must not complete without guardian consent');
  const ok = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', token: '0'.repeat(64), consent: true }) });
  if (ok.status !== 200) throw new Error('setup with consent must be 200, got ' + ok.status);
  const ck = ok.headers.get('set-cookie').split(';')[0];
  const H = { cookie: ck, 'content-type': 'application/json' };
  const consent = db.prepare(\"SELECT value FROM settings WHERE key='consent'\").get();
  if (!consent) throw new Error('consent must be recorded');
  // retention: set a purge, insert an old row, boot-time/daily purge removes it
  const r = await fetch(base + '/api/admin/retention', { method: 'PUT', headers: H, body: JSON.stringify({ days: 30 }) });
  if (r.status !== 200) throw new Error('retention set must be 200');
  // wipe: requires the typed confirmation
  const w1 = await fetch(base + '/api/admin/wipe', { method: 'POST', headers: H, body: JSON.stringify({ password: 'correct-horse-battery', confirm: 'WRONG' }) });
  if (w1.status === 200) throw new Error('wipe with wrong confirm must not run');
  server.close();
  console.log('privacy-ok');
});
" | grep -q privacy-ok
grep -q "DELETE" public/admin.html
grep -qi "retention" public/admin.html
grep -qi "guardian\|parent" docs/security-model.md
```

## Stop and ask if

- the research says consent must be VERIFIABLE in a way that implies
  contacting the parent out-of-band (email/phone verification) — that is a
  bigger feature (needs a mail channel); implement the in-app affirmative
  consent + artifact only, and flag the gap in your hand-back note
- the research's retention default for managed conflicts with "keep forever
  by default" for self-host — default self-host to keep-forever and ask
  about the managed default
- wiping must also remove the credentials/api_keys/sessions tables (default:
  YES, everything) — confirm by asking only if the research says otherwise

## Notes for the agent

- `wipe` logs to stdout immediately before destruction — after a wipe the
  `security_events` table is empty, so the stdout line is the durable audit
  record for the wipe itself.
- The retention timer must not run in the `:memory:` test process longer than
  the test needs (make the purge callable directly, and test by calling it,
  not by waiting 24h).
