# Research 0002 — What other autistic kids need from a home behavior board

Research task 0002, executed in-session 2026-11-05. Feeds tasks 0013
(capability model + presets) and 0014 (the wizard). The reference child
(whose board the app was built for) is **Type-2 autistic, emotional
dysregulation, sensory issues, unsafe behaviors present** — the current full
board (schedule + token economy + battery + tools + rules + ABC + check-ins +
pause) is exactly his profile, and it stays the `standard` preset. The
question this research answers: what do the OTHER kids' boards look like?

## Profile table

| # | Profile | Child sees | Console needs | Enable | Disable / drop | Gaps (new capability) |
|---|---|---|---|---|---|---|
| P1 | **Regulation** (reference) | full board: day, battery, tools, rules, rewards, week, pause banner | everything, incl. one-tap behavior procedure | schedule, rewards, choices, battery, tools, rules, abc, checkins, pause, plans | — | — (existing) |
| P2 | **Communication-first** (minimally verbal / AAC-adjacent) | big tap targets that SAY things: Yes / No / Break / More / Done; a picture of the day | requests log (what they asked for), schedule, no scoring at all | schedule, choices (as communication), tools (as "break") | battery, rules-X, abc, checkins, pause, reward minutes | **request events** (child tap → parent notified/logged as a request, not a behavior); large-button kiosk render; icon set beyond emoji |
| P3 | **Anxiety** | predictable day ahead, a worry meter (0–10 self-report), calm-down menu, "what's next" countdown | self-report check-ins from the KIOSK side, calm-down list, schedule | schedule, choices, tools (calm-down menu), checkins (self-report variant), plans | battery-as-punishment semantics, rules-X, abc (or note-only abc), pause | **child self-report** (kiosk-side check-in: "how's your tummy feeling?" 1–5); **countdown/visual timer** ("5 more min"); worry scale storage |
| P4 | **Transitions / executive function** | step-by-step task breakdown, first-then, strong "what's next", visual timer | task steps per activity, first-then pairing, schedule | schedule, rewards (light), choices, tools (light), plans | battery, abc, pause (or note-only) | **activity steps** (nested sub-items: "brush teeth → mouthwash → put brush back"); **first-then pairs** (target activity + its reinforcer, shown together); visual timer |
| P5 | **Sensory** (over/under-responsive) | sensory breaks as scheduled items, quiet-time plan, low-stimulation kiosk (no motion) | sensory break log (was it taken?), day plan with breaks built in | schedule (with break items), tools (sensory kit), plans, choices | battery, rules-X, abc (optional note-only) | **sensory-friendly render** (reduce/kill animations, high-contrast mode, bigger tap areas); breaks modeled as first-class schedule items (already possible via modes; just a preset) |
| P6 | **Routines / medical** (sleep, med, hygiene — no behavior goals) | a gentle checklist day + a small reward; "all done" celebration | the checklist, a light reward, history for the sleep/routine pattern | schedule, rewards (light), choices, plans | battery, tools, rules, abc, checkins, pause | — (mostly existing; preset is "strip most sections") |
| P7 | **Gentle / low-support** ("not every kid has unsafe behaviors") | day + what they're working for + all-done joy; no X anywhere | schedule, rewards, choices, plans, light history | schedule, rewards, choices, plans | **everything behavior-protocol: battery, rules, abc, checkins, pause** | — (this is the "positive-only" flag set: no X marks, no pause, no ABC) |
| P8 | **Family / shared** (whole-household responsibilities) | "our day" with each person's part; positive completion only | multiple named sections per day (per child/parent), completion log | schedule (multi-section), rewards (per person), choices | battery, rules-X, abc, pause, single-child identity | **multi-child / named sections** (deferred: one instance = one child today; this is the roadmap multi-child board — flag in wizard as "coming") |

## Per-profile notes

**P1 Regulation (standard).** Keep as-is. The battery/two-views (kid sees
lines, parents see 0–100 risk) design, the check-in AND tool resume gate, and
the one-tap procedure are the point. Sources: the reference program; general
ABA antecedent-based + reinforcement-pause practice (PMC token-economy review:
https://pmc.ncbi.nlm.nih.gov/articles/PMC10700257/ ,
https://pmc.ncbi.nlm.nih.gov/articles/PMC2648534/ ).

**P2 Communication-first.** The board stops being a *record of the child* and
becomes a *voice for the child*. Taps are requests. A parent's phone gets
"Sam tapped BREAK at 14:02" — not a behavior event. The console's "ABC log"
is replaced by a "requests log". This is the closest thing to an AAC
rapid-access board (https://aacspeech.app/resources/how-to-make-a-communication-board.html ,
https://vkc.vumc.org/assets/files/triad/tips/Communication_Boards.pdf ). The
existing `choices` + `tools` tables nearly map (tap = event with label); what
is missing is **request semantics + notification + large-button render**.
Wizard tone: "Does your child use words, some words, or mostly pictures and
gestures?" — never "nonverbal" as a label the family must select.

**P3 Anxiety.** Research-backed home supports: visual schedules and
first-then for predictability, "say it then show it"
(https://www.autismspeaks.org/tool-kit/autism-care-networkair-p-visual-supports-and-autism ,
https://www.readingrockets.org/topics/autism-spectrum-disorder/articles/visual-schedules-school-setting ),
transition warnings/countdowns, and a calm-down menu instead of a
discipline battery. The kiosk itself becomes a check-in surface: the child
self-reports (face scale 1–5) — that data is the "check-in" and replaces
parent-logged hunger/boredom as the primary signal. Missing: self-report
storage + kiosk-side check-in UI + countdown. The `minutes` field on
activities already supports timers (render gap only).

**P4 Transitions/EF.** Step breakdown and first-then are the core.
First-then is an established visual support (raisingbrilliance schedule kit:
https://raisingbrilliance.org/guides/free-printable-visual-schedule-autism ).
"Task analysis" (chaining steps) is standard OT/ABA practice for routines.
Missing: nested activity steps, first-then pairing render.

**P5 Sensory.** A "sensory diet" is a schedule of sensory inputs through the
day, typically OT-designed (https://www.theottoolbox.com/how-to-create-a-sensory-diet/ ,
https://www.autismontario.com/sites/default/files/2025-06/Sensory%20Diet%20at%20Home%20V2.pdf ).
The board fits it naturally: breaks are scheduled items, the tools card is
the sensory kit. The real gap is **render calm**: no pulsing banners, no
auto-motion, big quiet targets — a "low-stimulation mode" toggle. This is a
kiosk CSS/render task, small but important.

**P6 Routines/medical.** A checklist day with a light reward. Deliberately
NOT a behavior program. Preset = schedule + rewards(lite) + choices + plans.
(Privacy note: medication steps are the family's data; the generic seed says
"Get ready" not anything medical — same scrubbing rule as always.)

**P7 Gentle.** The "no unsafe behaviors" family. Positive-only: no X column,
no battery, no pause, no ABC. The kiosk is a day picture + what-they're-
working-for + all-done celebration. This is the profile that proves the board
isn't a surveillance device — and the wizard must make it as easy to pick as
the full protocol.

**P8 Family.** Deferred (multi-child is roadmap). The wizard should name it
as "coming" so those families know it's intended, and P7 is their stopgap.

## Feature gap list

Union of missing capabilities, mapped to the existing data model:

1. **Request events (P2):** child tap recorded as a *request* (table can
   reuse `tool_uses` semantics or a new `requests` table; console shows a
   requests log; optional notification = a generic webhook endpoint).
2. **Child self-report check-in (P3):** kiosk-side 1–5 scale tap stored as a
   `check_in` with `by='kiosk'` and a `self_report` flag — storage is
   existing; kiosk UI is new.
3. **Countdown / visual timer (P3, P4):** per-activity `minutes` already
   exists — render a "5 more min" countdown band on the kiosk; no new data.
4. **Activity steps / task chains (P4):** nested sub-items per activity —
   new table `activity_steps` or a mode where each "activity" is a step.
5. **First-then pairing (P4):** a schedule item declares its "then" — a
   `pair_with` reference on `mode_items`; render "first X, then Y".
6. **Large-button communication render (P2):** a kiosk layout mode: 4–8 giant
   targets, no schedule list.
7. **Low-stimulation render (P5, P2):** CSS/layout mode: no motion, no
   banner pulses, high contrast, bigger taps.
8. **Positive-only mode (P7):** the capability flags (task 0013) with X-marks,
   pause, and ABC disabled; "all done" copy that doesn't mention rules.
9. **Notifications (P2):** outbound webhook (and later ntfy/push) when a
   request is logged — the parent's phone is the other half of communication.
10. **Multi-child / named sections (P8):** deferred — roadmap.

Items 8 (and the flags under it) are what 0013 builds; 1–7, 9 are follow-on
tasks to queue AFTER the wizard proves the capability model (they are
render/data features, each small once the model exists).

## Kinder variants

The "gentle" axis, in one line per profile: P2's board makes a child
*heard*; P3's makes the day *predictable*; P4's makes tasks *possible*;
P5's makes the screen *calm*; P6's makes routines *visible*; P7's makes the
board *about the day, not about the mistakes*. The capability model exists so
a family gets the least board that serves their child — and the most only if
they ask for it.

## Wizard tone

- Ask about the **day**, not the diagnosis. "What does a normal day look
  like?" → weekday questions. Never "Is your child nonverbal?" — instead "How
  does your child tell you what they want? Words, some words, pictures,
  gestures?" and let the answer choose the profile.
- Present profiles as **what the board does for them**, one plain sentence
  each ("a picture of the day they can see coming", "a way to say yes, no,
  and break", "a calm-down plan you both follow", "just a kind checklist").
  The clinical name (P2–P7 labels) never appears in the UI; it is only in
  this doc and code.
- One question per screen; every question skippable with a sensible default;
  "I'm not sure" is an offered answer that picks `standard` and says "you can
  change any of this later — this is a starting point, not a contract."
- The child's name is optional throughout; the board works name-free.
- Close on agency: "You can turn any part of this on or off, today or any
  day. The board is yours."
- When the reference (dysregulation) profile is chosen, say what the battery
  and the procedure are FOR in one kind sentence — not a definition, a
  promise: "when feelings get big, you both have a plan instead of a
  guessing game."

## Sources

- https://www.autismspeaks.org/tool-kit/autism-care-networkair-p-visual-supports-and-autism
- https://pmc.ncbi.nlm.nih.gov/articles/PMC10700257/ (token economies, 2023 review)
- https://pmc.ncbi.nlm.nih.gov/articles/PMC2648534/ (token reinforcement review)
- https://raisingbrilliance.org/guides/free-printable-visual-schedule-autism
- https://www.readingrockets.org/topics/autism-spectrum-disorder/articles/visual-schedules-school-setting
- https://www.theottoolbox.com/how-to-create-a-sensory-diet/
- https://www.autismontario.com/sites/default/files/2025-06/Sensory%20Diet%20at%20Home%20V2.pdf
- https://aacspeech.app/resources/how-to-make-a-communication-board.html
- https://vkc.vumc.org/assets/files/triad/tips/Communication_Boards.pdf
- https://www.advancedautism.com/post/token-economy
- TEACCH visual supports program (Pittsburgh): https://www.teacch-pjm.org/ (visual structure principles)
- First-then / transition supports: https://www.autismspeaks.org (tool kits, transitions)
