---
id: 0001
title: Research — child-data law matrix (COPPA + states) for the PaaS tier
plan_ref: C
kind: research
provider: shadowbox
sandbox: research
risk: low
max_iterations: 3
estimated_minutes: 45
---

## Goal

Produce a US legal matrix for "software platforms intended for children", for
a behavior-dashboard service that has (a) a free self-hosted tier where the
family runs the server and is its own data controller, and (b) a future
managed/PaaS tier where WE operate the service and therefore carry operator
duties. Children using these boards are frequently under 13.

Answer, with cited URLs for every legal claim:

1. **COPPA (federal):** what an "operator of a website or online service
   directed to children" must do — verifiable parental consent (which methods
   qualify), direct notice to the parent, data minimization, retention and
   deletion limits, no behavioural advertising, the parent's rights to
   review/delete/refuse, and how "directed to children" is determined.
   State the analysis for BOTH tiers: is a self-host tool the operator uses
   still "directed to children" for us (the publisher), and is the managed
   tier unambiguously subject?
2. **Other federal:** FTC Act §5 (unfair/deceptive practices) touchpoints;
   whether the FTC Health Breach Notification Rule could ever reach
   behavioral data (it applies to "health data" held by vendors — argue both
   sides and give the conservative answer).
3. **State matrix (all 50 + DC):** which states have laws that could apply to
   a PaaS tier serving residents — minor privacy, biometric, or health-data
   laws (e.g. CCPA/CPRA's under-16 opt-out and parental rights, CT SB 3
   sensitive personal information incl. health/ASD, TX HB 300, CO/VA/MD
   health-data bills, state breach-notification triggers for health/minor
   data). Table form: state | law | applies to managed tier? | obligation |
   which of our features satisfies it (export, delete, consent, retention).
   For self-host: note the family's duties in one line per law.
4. **Minimum managed-tier compliance package:** the union of obligations from
   (1)–(3) turned into product requirements: consent flow, data inventory,
   retention schedule, deletion procedure, sub-processor disclosure, breach
   response, records of processing.
5. **Self-host tier:** a short "you are the data controller" note spec — what
   the docs must tell a family so that USING the tool is lawful for them.

Write the findings to `.autopilot/research/0001/output.md` with sections
`## Federal`, `## State table`, `## Managed-tier obligations`,
`## Self-host note`, `## Open questions`. Cite sources inline as URLs.
Assume US only; note (do not research) whether non-US (GDPR Art. 8 etc.)
matters as an open question. This feeds task 0017.

## Files in scope

- .autopilot/research/0001/output.md (new)

## Files explicitly out of scope

- every other file (research profile is read-only on tracked files)

## Acceptance

```sh
test -s .autopilot/research/0001/output.md
[ "$(wc -c < .autopilot/research/0001/output.md)" -gt 6000 ]
grep -q "## Federal" .autopilot/research/0001/output.md
grep -q "## State table" .autopilot/research/0001/output.md
grep -q "## Managed-tier obligations" .autopilot/research/0001/output.md
grep -q "## Open questions" .autopilot/research/0001/output.md
grep -q "COPPA" .autopilot/research/0001/output.md
grep -c "https://" .autopilot/research/0001/output.md | grep -qE "^[0-9]+$"
[ "$(grep -c 'https://' .autopilot/research/0001/output.md)" -ge 15 ]
```

## Stop and ask if

- you cannot find current (2025–2026) text for a state law and must rely on
  pre-2024 sources — flag each such row as `UNVERIFIED` instead of guessing
- it becomes clear the managed tier would be "directed at children" in a way
  that changes the whole posture (e.g. marketing to the kids themselves)
