# Research 0001 — Child-data law matrix (US)

Research task 0001, executed in-session 2026-11-05 (Kagi + primary sources).
This is engineering input, **not legal advice**; the independent sign-off
(PLAN workstream O) is the authoritative review. Verified URLs are cited;
items marked `UNVERIFIED` need a lawyer's eyes before launch.

## Federal

### COPPA (15 U.S.C. §§ 6501–6506; 16 CFR Part 312 — AMENDED, now in force)

The FTC amended the COPPA Rule in 2025 — this is the version that governs a
launch today (final rule, 90 FR 16918, published 2025-04-22, effective
2025-06-23; compliance dates cited in firm memos through 2026-04-22 — both
dates are in the past as of this writing).

Sources:
- Final rule (Federal Register API): https://www.federalregister.gov/api/v1/documents/2025-05904.json
- Current rule text (eCFR): https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312
- Firm analyses of the amendments:
  https://www.lw.com/en/insights/ftc-publishes-updates-to-coppa-rule ,
  https://www.hunton.com/privacy-and-cybersecurity-law-blog/coppa-rule-amendment-compliance-deadline-approaches ,
  https://www.koleyjessen.com/insights/publications/ftcs-strengthened-childrens-online-privacy-rules-now-in-effect

What applies to us:

1. **"Operator" scope.** COPPA binds any person operating an internet site or
   online service that collects or maintains personal information from/about
   users, for commercial purposes in interstate commerce. Nonprofits get a
   §5 FTC Act exemption. **The managed/PaaS tier: we are the operator. The
   self-hosted tier: the family is the operator of a non-commercial personal
   service — COPPA duties run to them (the parents), not to us.** Our
   marketing site is also our own service: keep it adult-facing (parent
   sign-up only) and it stays in the easy lane.
2. **What counts as "personal information" (16 CFR 312.2).** Names; online
   contact info; screen names that function as contact info; **persistent
   identifiers — explicitly including IP addresses** and device IDs;
   **photographs/video/audio files containing a child's image or voice**;
   street-level geolocation; **biometric identifiers — explicitly including
   voiceprints and faceprints**; and any info combined with an identifier.
   For a behavior board: the child's name, the ABC log (identifiable
   behavior history), any voice/image we might add, and the kiosk's IP are
   all in scope on the managed tier.
3. **"Directed to children" / mixed audience.** Our service is parent-facing
   (mixed audience). The amended rule requires that any age determination
   "be done in a neutral manner that does not default to a set age or
   encourage visitors to falsify age information" — so: parent asserts the
   child's age at sign-up; never default to "child"; collect age only after
   (or alongside) the guardian notice.
4. **Verifiable parental consent (16 CFR 312.5)** before collecting from a
   child. Permitted methods (b): signed form returned; credit-card
   transaction notice; toll-free staffed line; video conference;
   government-ID database check (ID deleted promptly); **knowledge-based
   authentication** (dynamic multi-choice questions a ≤12 in the household
   couldn't answer); government ID + webcam face match (deleted promptly);
   and — new in the amended rule's structure — **email plus additional
   assurance steps, available only to operators who do NOT disclose the
   child's personal information to third parties** (312.5(b)(viii)). We never
   share, so the email+steps path is available to us and is the cheapest
   sound option (email to parent + KBA challenge). **Separate consent is
   required for any third-party disclosure** (312.5(a)(2)) — we have none,
   but it must be stated.
5. **NEW — data retention, 16 CFR 312.10** (the amendments' headline).
   Operators may retain children's personal information **only as long as
   reasonably necessary** to the purpose; **"may not be retained
   indefinitely"**; a **written data retention policy is required** (purposes,
   business need, deletion timeframe) and **must be published in the §312.4(d)
   online notice**. Deletion means "not maintained in retrievable form and
   cannot be retrieved in the normal course of business."
   → Product consequences: a retention schedule with real timeframes
   (task 0017), a published policy, and backup deletion semantics (a
   restore-capable backup is retrievable — backups must be purged or
   encrypted-and-expiring; the encryption-at-rest work (0018) makes backups
   safe to keep for a bounded window).
6. **Notice (16 CFR 312.4).** Direct notice to the parent before collection
   (content list 312.4(c)(1)) and a comprehensive online notice (312.4(d))
   that must now include, among other things, the retention policy, the
   persistent identifiers used and how they are shielded from
   profiling/disclosure, and how any audio files are used and deleted.
7. **Parental rights (312.6–312.7).** Review the child's data, delete it,
   refuse further collection (we may then terminate that child's service);
   no conditioning participation on more collection than the service needs.
8. **Security (312.8).** Reasonable measures to protect confidentiality,
   integrity, and disposal — our hardening stack (TLS, at-rest encryption,
   passkeys, audit log) is the evidence base for this.
9. **New §312.12** — a voluntary FTC approval process for novel consent
   methods (e.g., a passkey-based parental consent could one day be
   FTC-approved); note for the future, not required.

### FTC Health Breach Notification Rule (16 CFR Part 318)

- Scope: "PHR entities" and their vendors — non-HIPAA providers that maintain
  personal health records, including consumer health apps. Current text:
  https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-318
- The FTC's 2024 final rule updated timing (breaches of 500+ individuals:
  notify individuals "without unreasonable delay," FTC within 60 days, media
  if 500+ in one state):
  https://www.insideprivacy.com/health-privacy/ftc-issues-final-rule-to-expand-scope-of-the-health-breach-notification-rule/
- On 2026-09-09 the FTC **rescinded the 2021 policy statement** that had
  aggressively extended HBNR to health apps/devices, saying the 2024 final
  rule superseded it:
  https://www.aha.org/news/headline/2026-09-10-ftc-rescinds-policy-statement-extending-breach-notification-rule-apps-devices-collect-health ,
  https://www.butzel.com/alert-ftc-rescinds-2021-guidance-on-health-breach-notification-rule
- **Conservative read for us:** a child's behavioral record (ABC logs,
  regulation data, notes naming a child) is "individually identifiable health
  information" in spirit and in most readings; if we operate the managed
  tier we should assume HBNR applies to us as a PHR-adjacent entity. Cost of
  compliance is one breach-response runbook: notify the family without
  unreasonable delay (target: 72h internal → family notice), FTC + state AGs
  per the rule's thresholds. `UNVERIFIED`: whether the FTC would treat a
  behavior board as a PHR product after the rescission — ask the
  security/privacy reviewer.

### FTC Act § 5 (unfair or deceptive practices)

Whatever else is in scope, § 5 applies to us always: our VALUES.md and
marketing claims (encrypted, private, no data selling, COPPA posture) must
be TRUE and our security "reasonable." The values doc is therefore a legal
artifact, not just positioning.

## State table

Verified in this session (details); `UNVERIFIED` rows = known law, details to
confirm at launch.

| State | Law | Status | Applies to managed tier? | Key obligations for us | Self-host note |
|---|---|---|---|---|---|
| CA | CCPA/CPRA (Cal. Civ. Code § 1798.100 et seq.) | in force | Only if we cross a "business" threshold ($25M revenue / 100k consumers / 50% from data); a tiny tier likely under it | Under-16: affirmative parent opt-in for any use of a child's PI we know to be <16; sensitive PI (health) gets extra use-limitation | Family personal use = not a "business"; no duty to us |
| CO | HB21-1116 (12-1-301 et seq.) | in force (7/1/2023) | Controller thresholds (100k CO consumers, or 25k + revenue test) — likely under at launch | "Sensitive data" incl. health, biometric, genetic, and data concerning <13; consent + limitation duties if in scope | n/a |
| CT | CTDPA, Pub. Act 22-8 (S.B. 3) + 2025 amendments | in force (10/1/2023) | Broad; 2025 amendments added a **consumer-health-data controller carve-out** with AG certification (portal.ct.gov) `UNVERIFIED`-details | "Sensitive data" incl. mental/physical health condition; <13 data sensitive; profiling limits; AG enforcement | n/a |
| TX | TDPSA (Bus. & Com. Code ch. 541, eff. 7/1/2024) + 2009 HB 300 (ch. 521 biometric) | in force | **TDPSA has no revenue/consumer threshold** — likely applies to us at any scale if doing business in TX | "Sensitive data" explicitly includes **personal data of a known child under 13**, precise geolocation, biometrics, health; parent/guardian may exercise rights for a known child; data minimization; breach notice 60 days (HB 521.053) | n/a |
| WA | My Health My Data Act (RCW 19.373, eff. 3/23/2024) | in force | **Likely applies at any scale** — regulates entities collecting "consumer health data" outside HIPAA; small-business relief exists below ~1,000 consumers `UNVERIFIED`-threshold | Broad "health data" (behavioral/mental health included); explicit consent; no sale/share; deletion on request; breach notice (45-day target in the statute) | Family personal use = the consumer, not the collector |
| MT | MCDPA (eff. 10/1/2024) | in force | Thresholds (25k+ MT consumers) — likely under at launch | Sensitive data incl. health; <13 requires guardian consent if in scope | n/a |
| VA | HB 2541 (2024 comprehensive law) | `UNVERIFIED` eff. date/scope | Confirm at launch | Sensitive data incl. health; minors category | n/a |
| MD | HB 1512 (2024) | `UNVERIFIED` details | Confirm at launch | Sensitive data incl. health | n/a |
| OR | ORS 646A (eff. 7/1/2024) | in force | Thresholds (500k OR consumers / revenue) — under | Standard duties; no special minors regime beyond sensitive data | n/a |
| LA, AL, DE, IA, TN, UT, NV, NH, NE, KY, etc. | Comprehensive consumer privacy laws (2024–2025 wave) | mixed | Most carry 100k+ consumer or revenue thresholds — a small tier is under most | Where "sensitive data" includes health/<13 (TN TIPA eff. 7/1/2025 is one to check), the same consent/deletion package covers it | n/a |
| FL | FIPA / health data bills | `UNVERIFIED` | Confirm at launch (FL has proposed health-data + biometric laws) | — | n/a |

Sources for the verified rows: https://portal.ct.gov/ag/sections/privacy/the-connecticut-data-privacy-act ,
https://www.bakerdonelson.com/consumer-data-privacy-law-guide-connecticut ,
https://fpf.org/blog/third-times-the-charm-connecticut-enacts-annual-privacy-update/ ,
https://www.texasattorneygeneral.gov/consumer-protection/file-consumer-complaint/consumer-privacy-rights/texas-data-privacy-and-security-act ,
https://statutes.capitol.texas.gov/Docs/BC/htm/BC.541.htm ,
https://www.consumerprivacyact.com/texas-data-privacy-and-security-act-tdpsa/ ,
https://www.atg.wa.gov/protecting-washingtonians-personal-health-data-and-privacy ,
https://epic.org/alive-and-kicking-washington-states-my-health-my-data-act-goes-into-effect-today/ ,
https://app.leg.wa.gov/RCW/default.aspx?cite=19.373&full=true ,
https://oag.ca.gov/privacy/ccpa ,
https://www.hklaw.com/en/insights/publications/2026/02/privacy-and-cybersecurity-legislation-in-texas ,
https://www.hipaajournal.com/what-is-texas-hb-300/

### The two states that bite at any scale

**Texas (TDPSA)** — no threshold; known-child-under-13 data is sensitive by
definition; parent can exercise rights; 60-day breach notice. **Washington
(MHMDA)** — purpose-built for consumer health data outside HIPAA; consent +
deletion + breach duties; small-business relief only below ~1,000 consumers
(unverified). A managed tier serving TX/WA families at any size must do:
explicit consent, minimization, deletion, and breach runbook. Everything else
falls out of the same package.

## Managed-tier obligations

The union, as product requirements (feeds task 0017 + the PaaS workstream):

1. **Guardian consent before activation.** Verifiable parental consent per
   312.5 — email-to-parent + knowledge-based challenge is our method (we make
   no third-party disclosures, so (b)(viii) is available). Record the
   consent artifact (who, when, IP) — it must survive deletion requests as a
   legal record. `UNVERIFIED`: KBA question bank source — buy, generate, or
   skip in favor of signed-form-by-email-scan.
2. **Two notices.** Direct notice at sign-up (312.4(c)(1) content) +
   published online notice (312.4(d)) including the retention policy, the
   identifiers we hold (kiosk IP, device data), and our no-sharing/no-audio
   statements.
3. **Written retention policy with real timeframes (312.10).** Proposed
   default (to confirm with the reviewer): raw check-in/ABC/battery events
   12 months rolling, day-level summaries indefinitely (tiny, and the point
   of the history view), consent artifacts kept for the life of the account
   + 2 years, backups encrypted and purged within 30 days. The board already
   has the `retention` control (0017) — the policy text must match the
   default.
4. **Deletion that means deletion (312.2 "delete").** Export (0010) → wipe
   (0017) → backups: encrypted blobs only (0018) and bounded. "Normal course
   of business" recovery access must be gone.
5. **Neutral age handling.** Guardian asserts age; no child-facing age
   prompt with a default; marketing site stays adult-only.
6. **Identifier hygiene.** The kiosk's IP on the managed tier: use for
   rate-limiting and the audit log (our security feature) but state it in the
   notice; do NOT persist a cross-device profile of the child (no
   persistent child identifier beyond the board account).
7. **Breach runbook (HBNR-conservative + state laws).** Internal 72h triage →
   family notice without unreasonable delay → FTC 60d (500+) / state AGs per
   statute (TX 60d, WA 45d target, most 30–45d) → media only if 500+ in one
   state (HBNR). One page, in `docs/` when the managed tier ships.
8. **No telemetry, no profiling, no advertising, ever** (COPPA 312.5(c)(7)
   spirit + VALUES.md): the identifier-shielding statement in the notice is
   true because the product has no analytics.
9. **Security evidence (312.8 / state "reasonable security").** The
   hardening stack + independent sign-off (PLAN O) is the record.

## Self-host note

Text for the self-hosting docs (feeds VALUES.md / self-hosting.md):

> When you self-host, you run the board on your own machine for your own
> family. You are the one who decides what is stored and who can see it — the
> law's duties about children's data (COPPA, state privacy laws) are duties
> on *operators of online services*, and a family's personal, non-commercial
> instance is not one of them. The software still protects you: data stays on
> your machine, it can be encrypted at rest, and there is a delete-everything
> control. If you give anyone else (a relative, a therapist, a provider)
> access or copies, that sharing is your decision under your own obligations.
> We publish the tool; we make no claims about your use of it, and we cannot
> see, back up, or recover what you run.

## Open questions

1. Does the FTC post-2026-rescission read HBNR onto a behavior board at all?
   (Assume yes until told otherwise — it is cheap.)
2. CT 2025 consumer-health-data controller carve-out: could we certify in,
   and is it worth it? (Probably not at launch scale; the package above is
   cheaper.)
3. KBA question bank: generate our own vs. licensed — consent-method detail.
4. Non-US: GDPR Art. 8 (parental consent, 13/16), UK, CA PIPEDA children's
   guidance, AU — out of scope for the US launch; the PaaS sign-up should
   state US-only until someone says otherwise.
5. Insurance: privacy/cyber policy for the managed tier — commercial
   decision, but the breach runbook and retention policy are what underwriters
   will ask for.
