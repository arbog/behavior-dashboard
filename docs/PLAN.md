# PLAN — behavior-dashboard

The project ledger. Autopilot tasks live in `.autopilot/queue/`
(format: `~/projects/autopilot/docs/TASK_AUTHORING.md`). The orchestrator
rewrites `[ ]` → `[x] (commit SHA)` on merge.

Routing: `kind: research` tasks run on **shadowbox** (fast, web egress);
`kind: code` tasks run on **evobox** (stronger coder). Research outputs land
machine-local at `.autopilot/research/<id>/output.md` — the operator copies an
accepted one into `docs/research/` (see handoffs below) before the dependent
code task runs. Dependent tasks carry a Stop-and-ask for the missing doc.

## V — Values & positioning
- [x] `VALUES.md` — public posture: free MIT core, cost-plus service,
  contract tier, no data selling, passion-project quality stated plainly
  (landed 2026-11-05, with this queue)

## H — Hardening II (the tier-1 backlog, 2026-11-05)
- [ ] `0005` XFF trust model (only from private peers) + limiter map hygiene
- [ ] `0006` DB file permission enforcement on boot (0600)
- [ ] `0007` Setup bootstrap token — closes the first-writer-wins admin race
- [ ] `0008` Session list + revoke ("signed-in devices")
- [ ] `0011` Trivy image scan in CI (report-only at first)

## K — Kiosk & data
- [ ] `0009` Per-device kiosk codes (replace the one shared token; revoke per device)
- [ ] `0010` JSON export + version in /healthz + browser-side update nudge

## I — Integration API
- [x] `0012` API keys (admin-scoped) + `docs/api.md` reference (landed 2026-11-05, in-session — suite also now asserts every server route appears in api.md)

## W — Personalization (the wizard)
- [x] `0002` research: child profiles & what other kids need →
  `docs/research/child-profiles.md` (landed 2026-11-05, in-session)
- [x] `0013` board-capability model + researched profile presets (landed 2026-11-05)
- [x] `0014` kind onboarding wizard (client-only flow over existing endpoints) (landed 2026-11-05)

## P — Passkey auth (see `docs/self-service.md`)
- [x] `0004` research: WebAuthn under zero-dep Node →
  `docs/research/webauthn.md` (landed 2026-11-05, in-session)
- [x] `0015` WebAuthn endpoints (credentials table, register/sign-in, audit) (landed 2026-11-05)
- [x] `0016` console passkey UI (enroll card + login button) (landed 2026-11-05)

## C — Compliance & privacy
- [x] `0001` research: child-data law matrix (COPPA + states) →
  `docs/research/laws.md` (landed 2026-11-05, in-session)
- [x] `0017` compliance controls (consent gate, retention, delete-everything) (landed 2026-11-05)
- [x] `0003` research: SQLite encryption-at-rest design →
  `docs/research/encryption.md` (landed 2026-11-05, in-session)
- [x] `0018` encryption at rest (whole-DB blob; the blob is the backup) (landed 2026-11-05)

## M — Managed tier & deploy (ATTENDED ONLY — secrets/infra, never queued)

The plan for all of it is public: **`docs/managed.md`** — the architecture
(one family, one container; per-tenant subdomains so passkeys bind to the
family's own origin), the trust model (what we can see, and the three ways a
family takes that trust back), the privacy-law layer, the breach runbook, the
cost-plus line items, and the launch checklist. Iterate there.

Server-side subtasks it creates (agent-buildable, queue after the consent
flow review):
- [ ] `0020` guardian consent flow — email + knowledge-based challenge,
      recording the consent artifact (the `consents` table exists since `0017`)
- [ ] `0021` key re-reveal + rotation — show the board passphrase again from
      the console with a passkey; rotate it (re-encrypt the blob)
- [ ] `0022` per-board webhook settings (today `BD_WEBHOOK_URL` env-only)

Attended items below stay attended:
- [ ] PaaS one-click deploy satisfying the `docs/self-service.md` contract
      (SECURE_COOKIES=1, setup-token flow, persistent volume)
- [ ] per-tenant provisioning automation on the homelab cluster — namespace,
      PVC, `board.enc` blob, subdomain + TLS, OpenBao secrets (until built,
      boards are provisioned by hand and `docs/managed.md` says so)
- [ ] encrypted backups (blob copy off-cluster, 30-day purge) + documented
      family deletion procedure
- [ ] the two notices + published retention policy (`docs/managed.md` §law)
- [ ] contract-tier pricing page (line items, per VALUES.md)
- [ ] backup-restore drill before the first family

## O — Sign-off (ATTENDED ONLY)
- [ ] independent cybersecurity review + public sign-off statement
- [ ] BCBA / clinical review of the protocol features + sign-off statement

## N — Identity (ATTENDED ONLY)
- [ ] name + domain. **Blocks PaaS launch and passkey RP-ID finalization —
      decide before 0015/0016 ship to production users.**

## Handoffs (operator actions)

All four research tasks were executed in-session on 2026-11-05 and their
outputs are **committed** (not machine-local) — the handoff is done, and the
gated code tasks can read `docs/research/*.md` directly.

| research task | committed at | consumed by |
|---|---|---|
| 0001 | `docs/research/laws.md` | 0017 |
| 0002 | `docs/research/child-profiles.md` | 0013, 0014 |
| 0003 | `docs/research/encryption.md` | 0018 |
| 0004 | `docs/research/webauthn.md` | 0015 |

## Review notes

0015–0018 are marked `risk: high` on purpose. If the orchestrator's review
gate is in use, hold them for human review even when acceptance passes —
they touch crypto, auth, and data integrity.
