---
id: 0014
title: Kind onboarding wizard (client-only flow over existing endpoints)
plan_ref: W
provider: evobox
sandbox: node
risk: high
max_iterations: 5
estimated_minutes: 60
thinking: high
---

## Goal

First-run should feel like a person walking you through it, not a settings
form. **Read `.autopilot/research/0002/output.md` (or
`docs/research/child-profiles.md`) first — the wizard's questions, the
profile chips, the per-profile seeds, and the TONE section all come from the
research. If that file is missing, STOP and ask.**

The wizard is a **client-only flow**: it is a new view in
`public/admin.html` that calls the EXISTING admin endpoints (0013 added
`PUT /api/admin/profile`; modes/choices/rules/tools/abc-options/bands/
rewards/protocol/identity already exist). No new server routes in this task.

Flow (adapt wording to the research's "Wizard tone" — non-clinical, asks
about the day, not the diagnosis):
1. **Welcome / who is this for** — child's name (may skip) →
   `PUT /identity`.
2. **What is their day like** — which weekdays are "normal", which are
   free/special → sets up modes + `PUT /weekdays` (or adopts the research's
   default week and lets them tweak).
3. **What should the board do** — profile chips (from 0013's `PROFILES`,
   with the research's plain-language descriptions) → `PUT /profile`. This
   re-seeds the enabled sections per the preset.
4. **The rewards** — what are they working for, how many minutes →
   `PUT /choices`, mode reward minutes.
5. **If battery/abc are on** — band words, check-in interval, rules, tools
   → `PUT /bands`, `PUT /protocol`, `PUT /rules`, `PUT /tools`,
   `PUT /abc-options`.
6. **Done** — show the kiosk code/device setup (link to the Kiosk devices
   card) and an "Open the kiosk" button. A "skip the tour, just show me the
   board" link is available on step 1.

Every step must be skippable-with-defaults (the seeds are already sensible)
and the wizard must be re-openable later from Settings ("Walk me through it
again"). Persist wizard completion in a `settings` row
(`onboarded_v1`) so first-run shows it once.

## Files in scope

- public/admin.html
- server.test.js (only if a test needs a settings-row helper; prefer no
  server change)

## Files explicitly out of scope

- server.js (NO new routes — if you believe a new endpoint is truly
  required, STOP and ask instead of adding one), docs/*, hardening.test.js,
  dbperms.test.js, compose.yaml, Dockerfile

## Acceptance

```sh
node --test
grep -q "onboarded_v1" public/admin.html
# wizard steps are wired to real endpoints, not invented ones:
for ep in "/api/admin/profile" "/api/admin/identity" "/api/admin/choices" "/api/admin/rules" "/api/admin/tools"; do
  grep -q "$ep\|$(basename $ep)" public/admin.html || { echo "wizard missing $ep"; exit 1; }
done
# the kiosk (child-facing) page must NOT contain wizard markup:
! grep -q "onboarded_v1\|Walk me through" public/index.html
# structural: a step-advance function and a skip path both exist
grep -qE "function (wizNext|wizAdvance|nextStep)" public/admin.html
grep -qi "skip" public/admin.html
```

## Stop and ask if

- the research's recommended flow needs a server endpoint that doesn't exist
  (e.g. "re-seed section X without wiping my edits" is not expressible with
  current endpoints) — do not add it; describe the gap and stop
- the wizard's tone research conflicts with a concrete UI decision (two
  reasonable readings) — pick the kinder one and note it

## Notes for the agent

- Keep it in the existing design language (the `.card`/`.pill`/`button.b`
  classes already exist — reuse them, don't add a CSS framework).
- The wizard is the parent's surface: phone-first, big tap targets, one
  question per step.
- Do not touch the kiosk (`public/index.html`) except to read the profile
  flags 0013 already puts in the payload — the capability-hiding rendering
  belongs to 0013's contract; if the kiosk doesn't yet honor
  `today.profile`, add that conditional rendering here (it is kiosk-side,
  which is in scope via the "no new server routes" rule only).
