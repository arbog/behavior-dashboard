# behavior-dashboard — working notes

Public, MIT-licensed, self-hosted behavior board for the autism/ABA community.
Working name; the product name + domain are open (docs/roadmap.md).

(`AGENTS.md` is globally gitignored in the maintainer's setup, so it is committed with
`git add -f`. It must be tracked: agents work in `git wt` worktrees, which contain only
tracked files.)

## The non-negotiable privacy rule

This repo is public and describes software, never a real family. **Nothing that identifies
a real person or their program may enter it:** no real names or nicknames, no clinical or
session schedules, no medication or health lines, no behavior documents or protocols copied from a
real family's packet, no real places or trip plans. All board copy is data; the seeds in
`server.js` (`DEFAULTS`, the weekday/free/trip templates) are deliberately generic and must
stay that way. If you are porting anything from a private source, scrub it first.

The list of strings to check for is **not in this repo** (it is public, and the list would be
the very thing it forbids). Maintainers keep it outside the repo and run, before pushing or
opening a PR:

```bash
scripts/privacy-check.sh            # checks what your branch ADDS (and commit messages) vs origin/main
```

It reads `~/.config/behavior-dashboard/privacy-denylist` (or `$BEHAVIOR_DASHBOARD_DENYLIST`) and
**fails closed**: with no denylist it refuses rather than report "clean". A hit is a review,
not a merge. Maintainer-only private notes, if present, are at
`~/.config/behavior-dashboard/AGENTS.private.md`. Contributors without that file: do not
add anything personal, and the maintainer will run the check on your PR.

## Conventions

- **Zero npm deps, keep it that way.** `node:http` + `node:sqlite` +
  `node:crypto` (Node ≥ 22.13) and vanilla JS in the two HTML files. No
  express, no build step, no CDN. The Docker image is the source plus a
  runtime — that is a selling point, not an accident.
- **Security posture is "private by default":** shells public, data gated
  (kiosk code for `/api/today*`, admin session for `/api/admin/*`). Read
  `docs/security-model.md` before touching auth, headers, or rate limits.
  me/login/setup are the only unauthenticated admin endpoints, and each must
  stay that way. The hardening pass (PR #1, 2026-11-05) added: security
  headers on every response; `SECURE_COOKIES=1` for HSTS + Secure cookies
  (PaaS templates must set it); per-IP rate limits (kiosk 60/min, admin
  300/min, login 10/min + 15-min lockout); the `security_events` audit trail
  (capped 500, exposed at `/api/admin/security`, shown in Settings → Security
  log); session wipe on password change; weak-password blocklist; `?token=`
  honoured only on the initial GET /api/today. Don't remove any of it to
  "simplify" — the PaaS story is exactly this surface.
- **All board copy is data, not code.** Battery bands, reward lines, the
  protocol text, the check-in interval, the child's name: settings-table
  driven with neutral `DEFAULTS`. Never hardcode a family's wording.
- **Tests drive the API, not the internals** (`server.test.js` boots the real
  server on an in-memory DB). When you add an endpoint, add its security and
  behaviour assertion there. Run with `node --test` (Node from
  `nix shell nixpkgs#nodejs_22` here).

## Deploy

GitHub Actions (`.github/workflows/ci.yml`): `node --test` on every PR; image build +
push to `ghcr.io/arbog/behavior-dashboard` (`:latest` + `:<sha>`) on main merges.

Git: work on a branch off `main` (a worktree: `git wt <topic>`), sign commits, run
`scripts/privacy-check.sh`, push the branch, open a PR, merge with `gh pr merge <n> --merge`.

## Related

- `docs/roadmap.md` — name/domain open questions, the "click a button" deploy
  story, managed option, known gaps.
