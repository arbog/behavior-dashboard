---
id: 0002
title: Research — what other autistic kids need from a home behavior board
plan_ref: W
kind: research
provider: shadowbox
sandbox: research
risk: low
max_iterations: 3
estimated_minutes: 45
---

## Goal

The reference child is Type-2 autistic with emotional dysregulation and
sensory issues, and the current board reflects exactly that: schedule + token
economy, a "battery" for regulation, coping tools, rules, ABC logging,
check-ins, reinforcement pause. **Not every kid has unsafe behaviors** and
not every board needs the protocol half. Research what OTHER autistic (and
neurodivergent) kids need from a home behavior/communication board, so a
kind onboarding wizard (tasks 0013/0014) can offer a board shaped to the
child instead of one shaped to our child.

Produce, with cited sources (URLs — TEACCH/PRT/NET/ABA home strategies,
autism parenting community, pediatric OT literature):

1. **5–8 child profiles** beyond the reference. Candidate list to start
   from (expand/replace with what the research supports): nonverbal or
   emerging-communication (board as visual schedule + AAC-adjacent
   communication), high anxiety (worry meter, calm-down menu, predictable
   transition warnings), transitions/executive-function (first-then, visual
   timers, task breakdown), sleep/medication routines (no behavior content,
   pure schedule + reward), sensory over/under-responsivity (sensory diet
   schedule, breaks as first-class items), low-support needs (schedule +
   reward ONLY — explicitly no battery, no Xs, no ABC), family/sibling
   shared board (chore/responsibility framing), and the reference
   dysregulation profile.
2. **Per profile:** what the board should SHOW the child, what the
   caregiver CONSOLE needs (or can hide), which existing features matter
   (schedule/modes/plans, token economy/rewards, choices, battery, tools,
   rules, ABC, check-ins, pause), and what is MISSING or must be disabled
   (e.g. no-X "positive only" mode, communication buttons, visual timer,
   sensory break items that are part of the schedule not a reward).
3. **Feature-gap list:** the union of missing capabilities, each with a one
   line on how it would map onto the existing data model (a mode kind? a new
   card? a disabled section?).
4. **Kindness notes:** for each profile, the tone the wizard should use —
   the wizard walks through "what's your kid's issues?" and must be
   non-clinical, non-labeling where the family doesn't label, and gentle.
   Capture the phrasing approach (ask about what the day looks like, not
   about diagnoses).

Write to `.autopilot/research/0002/output.md` with sections `## Profile
table`, `## Per-profile notes`, `## Feature gap list`, `## Kinder variants`,
`## Wizard tone`, `## Sources`. This feeds tasks 0013 and 0014.

## Files in scope

- .autopilot/research/0002/output.md (new)

## Files explicitly out of scope

- every other file (research profile is read-only on tracked files)

## Acceptance

```sh
test -s .autopilot/research/0002/output.md
[ "$(wc -c < .autopilot/research/0002/output.md)" -gt 6000 ]
grep -q "## Profile table" .autopilot/research/0002/output.md
grep -q "## Per-profile notes" .autopilot/research/0002/output.md
grep -q "## Feature gap list" .autopilot/research/0002/output.md
grep -q "## Wizard tone" .autopilot/research/0002/output.md
grep -q "## Sources" .autopilot/research/0002/output.md
[ "$(grep -c 'https://' .autopilot/research/0002/output.md)" -ge 10 ]
```

## Stop and ask if

- the research suggests a profile that needs a capability far beyond the
  current data model (e.g. a full AAC board) — list it under "deferred"
  rather than over-specing the wizard
