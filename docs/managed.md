# The managed tier: how we host your board, and what that means

**Status: plan.** This document is how hosting on your behalf will work. It
is written before the first paying family, so you can read it and disagree
with it. Where something is not built yet, it says so. Where something cannot
be promised, it says that too. This document is public, versioned in the same
repository as the code, and wrong in the same commit history as everything
else.

## The shape of it

You get a board that works: a URL, your family's own instance, HTTPS with a
real certificate, a passkey instead of a password, backups that happen
without you, and updates that arrive without you. Your child taps the kiosk;
you run the protocol from the console. We run the boring parts.

The software is **exactly the free, MIT-licensed core**. There is no managed
edition, no premium toggle, no server-side code you could not read right here.
A managed board is the same container a self-hoster runs, started by us
instead of you.

## One family, one machine — the isolation story

This is the most important architectural fact, so it is first:

**Every family gets their own isolated container. There is no shared
database.** The board was built as a single-family application — one SQLite
database, one admin, one kiosk — and the managed tier does not change that.
Hosting on your behalf means running *your own copy* of the app next to other
families' copies, not pouring many families into one schema.

Concretely, per family:

| Thing | What it is |
|---|---|
| **Container** | One instance of the public image, in its own Kubernetes namespace, with its own resource limits and network policy. Your board cannot open a connection to another family's board, and neither can we say "oops, cross-tenant query" — the architecture makes it unpronounceable. |
| **Database** | One SQLite file on a dedicated persistent volume, encrypted at rest (the whole-DB blob, `0018`) with a passphrase generated for your board. |
| **Domain** | `https://<yourname>.board.arbog.xyz` — a real subdomain per family, so your **passkeys are bound to your own origin**. WebAuthn credentials only work on the exact domain they were created for; that is a feature, and it is why per-family subdomains are non-negotiable. (A family may point its own subdomain at its board later; see "what changing your domain means", below.) |
| **TLS** | Terminated at the edge, wildcard certificate per managed domain. `SECURE_COOKIES=1` is on. |
| **Backups** | The encrypted blob is copied off the cluster on a schedule. Because it is ciphertext, a leaked backup is a useless file (research: `docs/research/encryption.md`). Backups are purged on a 30-day rolling window, and when a family deletes their board, the backups go with it inside that window. |
| **Secrets** | Your board's passphrase and setup token live in our OpenBao instance (an open-source vault), scoped to your board, never in the repository or the container image. |

## What we can see, and what we cannot

We will not pretend to a trust model we cannot deliver. Here it is plainly:

**We can see.** The board runs on our machine; the decryption passphrase for
your database is in our vault. Our operations role can, technically, read
your family's data. Anyone who tells you a hosted service operator *cannot*
see your data while holding the keys is lying or does not understand their own
system.

**We will not, except:** to restore from a backup at your request, to debug a
problem you have asked us to debug, or to comply with a legal order (which we
will tell you about unless we are legally barred). Every one of those access
events is logged, and the log is part of this agreement.

**You can take the trust out of our hands.** Three ways, all built:

1. **Download your key.** The passphrase is shown once at setup and can be
   re-revealed from your console with your passkey. Hold it yourself, and our
   vault copy is a convenience, not a necessity.
2. **Export everything, any time.** The JSON export (one dated file, every
   table) is a first-class button in the console — no support ticket, no
   waiting period.
3. **Leave.** Export, or take the encrypted blob and the passphrase, and run
   the same code on your own hardware. The self-host path is the same
   software, so leaving is a migration, not a rewrite.

## The privacy law layer (US)

The research behind this section is public: `docs/research/laws.md`. On the
managed tier **we are the operator** of an online service collecting data
from/about children, and we hold the duties. This is what we will have in
place before the first family signs up:

1. **Verifiable parental consent before the board exists.** Per the amended
   COPPA rule (16 CFR 312.5), and because we make no third-party disclosures,
   we use the email-plus-assurance path: consent is requested from the
   parent's email address and completed with a knowledge-based challenge.
   The consent artifact (who, when, from where) is recorded per board and
   **survives even a full deletion** — a deletion record is the one thing a
   deletion request must leave behind.
2. **Two notices, published.** A direct notice at sign-up (what we collect:
   your child's name if you give one, the behavioral record you and the
   kiosk create, and the kiosk device's IP address for rate-limiting and the
   audit trail — and nothing else), and an online notice carrying the
   retention policy below, our no-telemetry/no-profiling statement, and the
   fact that we do not use, and have nowhere to put, advertising identifiers.
3. **A written retention policy with real numbers** (16 CFR 312.10):
   - raw events (ABC, battery, tools, check-ins): **rolling 12 months**
   - day summaries and history: the life of the board
   - consent artifacts: the life of the account + 2 years
   - backups: encrypted, **purged within 30 days**
   The board's retention control ships with exactly these defaults, and the
   family can change them — tighter or zero.
4. **Deletion that means deletion.** The console's delete-everything control
   wipes the board's data; the retained backups are purged within 30 days;
   and the deletion is recorded. Self-serve, no ticket.
5. **Neutral age handling.** The parent asserts the child's age at sign-up;
   no prompt asks the child; the marketing site stays adult-facing.
6. **State laws.** Two states bite at any scale — Texas (known-child data is
   sensitive, parent rights, 60-day breach notice) and Washington (consumer
   health data: explicit consent, deletion, breach notice). Everything the
   COPPA package builds covers both. Until the reviewers (below) say
   otherwise, we assume the FTC health-breach rule reads onto a child's
   behavioral record, because building the breach runbook is cheap and
   guessing wrong is not.
7. **US-only at launch.** The sign-up states it. GDPR and other regimes are
   out of scope until someone who is not us says otherwise.

## The breach runbook (summary)

Internal triage within 72 hours → the affected families are told without
unreasonable delay → FTC within 60 days where thresholds apply (500+
individuals) → state notifications per statute (TX 60 days, WA 45-day
target). One page, tested against a restore-from-backup drill, published
when the managed tier launches.

## The journey of a family

1. **Sign-up & consent** — the parent fills a short form; we email the
   consent request; the KBA challenge completes it. Not built yet (tracked
   in the plan below).
2. **Provisioning** — a board is created for the family: namespace, volume,
   encrypted blob, subdomain, TLS, secrets. The family receives their setup
   token and their board's URL. (Automation not built yet; until it is, the
   first boards are provisioned by hand, and we will say so.)
3. **First run, on their board** — the setup token unlocks the console; the
   passkey is enrolled (Face ID / Windows Hello / a security key); the
   family walkthrough asks about the child's day, not their diagnosis, and
   picks a starting profile — with everything adjustable later.
4. **The kiosk** — the family names a device, gets its code, puts it on the
   TV. From here, it is their board.
5. **Leaving, when they leave** — export, or blob + passphrase. Our copies
   and backups are deleted on request.

## What "cost-plus" costs

VALUES.md promises line items, so the shape is here and the final numbers
will be published at launch, per month, per family:

- a slice of the cluster node the boards run on (tiny — one board is one
  small container),
- the wildcard certificate (amortized across tenants),
- backup storage (encrypted, small),
- a share of the security work: the independent review is paid for by the
  contract tier, so the community tier is not subsidizing its own audit.

The disclosed margin is the difference between that number and the price.
The free tier is free. Nobody pays for the software twice.

## What we will not run on the managed tier

- **Advertising, tracking, or analytics of any kind.** There is no analytics
  code in the app; there is nowhere for it to go.
- **Reading boards** outside the exceptions above. If we ever change that,
  this document changes first, in public, and we consider any family's
  departure a rating of that decision.
- **A second tier of features.** The managed tier buys hosting, backups,
  HTTPS, and time — not features. The features live in the free core.

## Launch checklist (what must be true before the first family)

- [ ] Name and domain decided (`PLAN` workstream N) — it fixes every board's subdomain and passkey binding
- [ ] Consent flow built and recording artifacts (`managed.md` §law layer)
- [ ] The two notices written, published, and linked from sign-up
- [ ] Retention defaults match the published policy (they do in code; verify at launch)
- [ ] Backup restore drilled: blob off-cluster → restored board, with the passphrase
- [ ] Provisioning automated, or the manual step stated in plain words at sign-up
- [ ] Breach runbook written and the contacts in it real
- [ ] Independent cybersecurity review done and published (`PLAN` workstream O)
- [ ] BCBA/clinical review done and published (`PLAN` workstream O)

Until every box is checked, the managed tier is not for sale, and the sign-up
page (when it exists) will say so. That is the promise this document makes:
we would rather be late than over-compliant-in-reverse.

## Open questions we are working on

- Custom domains for families (their own subdomain pointing at their board):
  works technically (per-board TLS cert), changes the RP-ID story for
  passkeys — needs the wizard to say "changing your domain signs out all
  passkeys" loudly.
- Recovery codes / a second key holder: out of scope for v1; a lost
  passphrase on the managed tier is recoverable by us (we hold it), which is
  the trade for the trust model above.
- Whether the FTC still reads the health-breach rule onto a behavior board
  after the 2026 rescission — the runbook gets built either way.
