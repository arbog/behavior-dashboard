---
id: 0013
title: Board-capability model + researched child-profile presets
plan_ref: W
provider: evobox
sandbox: node
risk: medium
max_iterations: 3
estimated_minutes: 50
thinking: high
---

## Goal

Not every board needs the battery, the ABC log, or the X-marked rules — a
calm kid who just needs a visual schedule and a reward shouldn't see a
"big feelings" protocol they don't use. Introduce a **board capability
model** so sections can be turned on/off per child, and seed it with the
profile presets the research produced.

**FIRST: read `.autopilot/research/0002/output.md` (or `docs/research/
child-profiles.md` if the operator committed it there) — the per-profile
notes and feature-gap list are the source of truth for which presets exist
and what each enables. If that file is missing, STOP and ask (see below).**

Implementation:
- A `board_profile` setting (JSON) describing which capabilities are on,
  e.g. `{ id, schedule, rewards, choices, battery, tools, rules, abc,
  checkins, pause, plans }` (booleans; `schedule` and `rewards` are the
  irreducible core — never disable-able).
- **Presets** defined in `server.js` (a `PROFILES` constant) from the
  research: at minimum a `standard` (everything on — the current default,
  matching the reference dysregulation profile), a `gentle` /
  `schedule-only` (schedule + rewards + choices, NO battery/abc/rules-X/
  pause), and the other profiles the research supports (each preset = a
  named capability set + sensible seed data for the enabled sections). The
  exact set and their seeds come from the research doc, not from invention.
- `todayPayload()` and `adminConfig()` include the active `profile`
  (id + capability flags) so the kiosk and console can render conditionally.
  When a capability is off: the kiosk hides that section (battery card,
  tools card, rules column, pause banner, ABC), and the corresponding admin
  write endpoints return `404 { error: 'capability disabled' }` for that
  section (so an old client can't write into a hidden surface). Read
  endpoints keep working and just omit the section.
- A `PUT /api/admin/profile { id }` endpoint to switch presets (admin-gated,
  audited). Switching does NOT delete data in a now-hidden section — it
  just stops showing/accepting it (re-enabling brings it back intact).
- **No UI in this task** — that is 0014. The server model + presets +
  payload flags + 404-gating + tests are the unit here.

## Files in scope

- server.js
- server.test.js

## Files explicitly out of scope

- public/* (the wizard/UI is 0014), docs/*, hardening.test.js,
  dbperms.test.js, compose.yaml, Dockerfile

## Acceptance

```sh
node --test
node -e "
process.env.DB_PATH = ':memory:';
process.env.SETUP_TOKEN = 'e'.repeat(64);
const { server, db } = require('./server.js');
server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const setup = await fetch(base + '/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery', token: 'e'.repeat(64) }) });
  const ck = setup.headers.get('set-cookie').split(';')[0];
  const H = { cookie: ck, 'content-type': 'application/json' };
  // default is the full profile
  let today = await (await fetch(base + '/api/today', { headers: H })).json();
  if (!today.profile || today.profile.id !== 'standard') throw new Error('default profile must be standard, got ' + today.profile && today.profile.id);
  // switch to a capability-light profile from the research
  const profiles = [...require('node:fs').readFileSync('server.js','utf8').matchAll(/id:\s*'([a-z-]+)'/g)].map(m=>m[1]);
  const light = profiles.find(p => p !== 'standard');
  if (!light) throw new Error('expected at least one non-standard preset in PROFILES');
  const sw = await fetch(base + '/api/admin/profile', { method: 'PUT', headers: H, body: JSON.stringify({ id: light }) });
  if (sw.status !== 200) throw new Error('profile switch must be 200, got ' + sw.status);
  today = await (await fetch(base + '/api/today', { headers: H })).json();
  if (today.profile.id !== light) throw new Error('profile did not take');
  // a disabled capability's write endpoint must now 404
  if (today.profile.battery === false) {
    const r = await fetch(base + '/api/admin/battery', { method: 'POST', headers: H, body: JSON.stringify({ delta: 1 }) });
    if (r.status !== 404) throw new Error('battery write must 404 when capability off, got ' + r.status);
  }
  // data preserved: switch back and the battery state is intact
  await fetch(base + '/api/admin/profile', { method: 'PUT', headers: H, body: JSON.stringify({ id: 'standard' }) });
  const back = await (await fetch(base + '/api/admin/regulation', { headers: H })).json();
  if (typeof back.battery.lines !== 'number') throw new Error('re-enabling must restore the section with its data');
  server.close();
  console.log('profile-ok');
});
" | grep -q profile-ok
```

## Stop and ask if

- `.autopilot/research/0002/output.md` AND `docs/research/child-profiles.md`
  are both missing — the presets must come from the research, not invention
- the research recommends a capability the current data model cannot express
  (e.g. a communication button or visual timer) — implement only the
  capability FLAGS for those (so 0014 can render a "coming" state) and list
  the gap in your hand-back note rather than building the feature

## Notes for the agent

- The acceptance discovers the non-standard preset by regex over
  `PROFILES` — define presets with single-quoted `id: 'slug'` so the check
  finds them.
- Keep `schedule`/`rewards` always-on: the kiosk is meaningless without a
  day, and the token economy is the point. If a research preset wants no
  rewards, model it as rewards-on-with-zero-minutes, not rewards-off.
