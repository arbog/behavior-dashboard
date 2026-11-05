# Values

This is a public document. It is what we intend the project to be, not what a
marketing page would like it to be. Read it before you rely on us.

## What this is

behavior-dashboard is a self-hosted behavior board for one family: the kiosk a
child taps, and the console a caregiver protocol runs on. It was built by a
parent running an ABA-style program at home, for the autism/ABA community that
does the same. It is a passion project. It is also, we hope, a thing the
community can run and trust with a child's data.

## The software is free, and stays free

- **MIT licensed.** Self-host it on your own machine, a Raspberry Pi, a home
  server, or a VPS. You pay $0 for the software, forever. No license fee, no
  "enterprise edition," no feature held hostage behind a paywall, no account
  required, no telemetry, no phone-home.
- **No one can make you pay for the thing you already have.** The source is
  here, the build is a container or a `node server.js`. A fork of this by
  anyone, for any reason, is legitimate and welcome. We do not consider a
  community fork a threat; we consider it the point.
- **The kiosk, the console, and the protocol engine are all in the free core.**
  We will not put the part a family actually needs behind a subscription.

## We are anticapitalist about this, on purpose

We do not believe a parent's need to keep a child safe and regulated is a
market to be extracted from. We are not building a product to maximize
lifetime value per family. We are building a tool, putting it where anyone can
take it, and earning from the parts of the work that genuinely cost money to
deliver for other people.

That means:

- **We are up front about our costs.** This project runs on real things:
  compute (the local inference boxes that build and test it), hosting for the
  managed tier, time. We will not pretend it is free to *us*. What we will do
  is not price it the way a venture-backed company prices it — to extract the
  maximum a family will pay. We price the service at roughly what it costs to
  run and keep safe, plus a modest, disclosed margin that keeps the lights on
  and the security work funded. If you want the number, ask; we will show you
  the line items.
- **Passion-project quality, honestly labeled.** We are a parent and a builder,
  not a vendor with a support army and a compliance department. The free
  self-hosted path is maintained with the same care we give our own child's
  board — serious about security, slower about everything else. If you need
  guaranteed uptime, a response-time SLA, or a throat to choke, that is not
  what this is, and we will not pretend otherwise. Buy the tier that actually
  provides that (below), or self-host and own it yourself.
- **We make the world a little kinder to autistic kids without extracting
  every possible dollar.** That is the whole thesis. The tool is free. The
  hosting is cost-plus. The margin is disclosed. The rest of your money stays
  in your pocket, where a family needs it.

## How we earn (the service tiers)

| Tier | What it is | What it costs | Who it's for |
|---|---|---|---|
| **Self-hosted** | The MIT source. You run the container. | Free. Your own hardware + electricity. | Families who will run it themselves, or who have someone who will. |
| **Managed (community)** | We run the container for you on shared infrastructure. HTTPS, the passkey setup, the backups. Cost-plus pricing, disclosed. | A small, honest monthly amount that covers the box, the cert, the backup, and our time keeping it safe. | Families who would rather not touch a server. This is the "pay for the service, not the software" tier. |
| **Contract (gov / business)** | Deployed for an agency, school district, or company: dedicated instances, SLA, the compliance sign-off, named support, and liability we are actually willing to carry. | Priced like real contracted work — higher, because it is. This is what funds the security audit and the therapy review below. | Organizations that can contract, and that need the accountability a family cannot. |

The contract tier is where the real money is, and we are open about that:
selling to a government or a school at a professional rate is how a small
project pays for its own independent security review without asking families
to subsidize it. Families get the free and the cost-plus tiers; organizations
get the accountable one. Nobody is asked to pay more than their tier needs.

## Data is the child's, full stop

This is not a value we market; it is the architecture:

- **Self-hosted means the data never leaves your machine.** One SQLite file.
  We have no handle on it, no copy, no telemetry channel to get one.
- **On the managed tier, it is encrypted in the database, reliably retrievable
  by you, and deletable by you.** You can get your child's whole record out,
  in a format you own, at any time. "Export and leave" is a first-class
  promise, not a support ticket.
- **We comply with the laws that apply to software intended for children** —
  COPPA at the federal level in the US, and the state-level requirements in
  every state the managed tier operates in. The particulars are being mapped
  (see `docs/`); the posture is fixed: we build to the strictest reasonable
  reading, and we would rather be over-compliant than discover a gap with a
  child's data in it.
- **We seek sign-off from people who are not us** — an independent
  cybersecurity review and a review from someone credentialed in child
  behavior/therapy (a BCBA or equivalent) — so the claims in this document are
  not just our word. Until those are done, read "we intend" wherever it
  matters.

## Security is a feature we fund, not a checkbox

- Private by default: the page shells are public, **the data is not**. Kiosk
  reads and writes need the kiosk code; the console needs the parent's
  credential.
- Hardened in the app (headers, rate limits, lockouts, a bounded audit trail),
  and hardened at the edge (TLS, HSTS when `SECURE_COOKIES=1`).
- A bounded on-server log answers "who touched this, when, from where" —
  including the attempts that did not get in.
- We want an independent professional to look at all of that and either bless
  it or tell us where we are wrong. That review is paid for by the contract
  tier, so families are not the ones footing the bill for their own safety.

## What we will not do

- Sell or share a child's data. Ever. There is no "anonymize and aggregate"
  escape hatch we will quietly use later.
- Put telemetry in the free build. If a future version ever phones home, it is
  off by default, disclosed here first, and never on for the kiosk.
- Paywall the core. The schedule, the battery, the protocol, and the records
  stay in the MIT build.
- Quietly change these values. If any of the above changes, this file changes
  in the same commit, and the change is a release note, not a footnote.

## The honest fine print

This is a passion project by a parent. It is security-conscious,
law-conscious, and free — and it is also one person's work, carried alongside
a job and a kid who is the reason it exists. Set your expectations to
"passion-project quality, held to a professional standard where a child's
safety is concerned." That is the whole trade, stated plainly: you get more
care where it matters, and less of everything that doesn't.

If that trade is right for you, run it. If you need more, the contract tier
is there, and it is priced like the accountability it carries.
