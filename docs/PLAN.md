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
- [ ] `0012` API keys (admin-scoped) + `docs/api.md` reference

## W — Personalization (the wizard)
- [ ] `0002` research (shadowbox): child profiles & what other kids need
- [ ] `0013` board-capability model + researched profile presets
- [ ] `0014` kind onboarding wizard (client-only flow over existing endpoints)

## P — Passkey auth (see `docs/self-service.md`)
- [ ] `0004` research (shadowbox): WebAuthn under zero-dep Node
- [ ] `0015` WebAuthn endpoints (credentials table, register/sign-in, audit)
- [ ] `0016` console passkey UI (enroll card + login button)

## C — Compliance & privacy
- [ ] `0001` research (shadowbox): child-data law matrix (COPPA + states)
- [ ] `0017` compliance controls (consent gate, retention, delete-everything)
- [ ] `0003` research (shadowbox): SQLite encryption-at-rest design
- [ ] `0018` encryption at rest (whole-DB blob; the blob is the backup)

## M — Managed tier & deploy (ATTENDED ONLY — secrets/infra, never queued)
- [ ] PaaS one-click deploy satisfying the `docs/self-service.md` contract
      (SECURE_COOKIES=1, setup-token flow, persistent volume)
- [ ] per-tenant instances on the homelab cluster; encrypted volumes
- [ ] encrypted backups + documented family deletion procedure
- [ ] contract-tier pricing page (line items, per VALUES.md)

## O — Sign-off (ATTENDED ONLY)
- [ ] independent cybersecurity review + public sign-off statement
- [ ] BCBA / clinical review of the protocol features + sign-off statement

## N — Identity (ATTENDED ONLY)
- [ ] name + domain. **Blocks PaaS launch and passkey RP-ID finalization —
      decide before 0015/0016 ship to production users.**

## Handoffs (operator actions)

| research task | copy accepted output to | consumed by |
|---|---|---|
| 0001 | `docs/research/laws.md` | 0017 |
| 0002 | `docs/research/child-profiles.md` | 0013, 0014 |
| 0003 | `docs/research/encryption.md` | 0018 |
| 0004 | `docs/research/webauthn.md` | 0015 |

## Review notes

0015–0018 are marked `risk: high` on purpose. If the orchestrator's review
gate is in use, hold them for human review even when acceptance passes —
they touch crypto, auth, and data integrity.
