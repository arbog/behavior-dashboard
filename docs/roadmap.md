# Roadmap

What is deliberately not here yet, and the order we are thinking in.

## Open questions

- **Name.** `behavior-dashboard` is the working name. The product name and the
  domain are still open (something like `my-super-behavior-board.example` is
  the placeholder in people's heads). Decide before the site ships.
- **Brand.** The current visual language is a dark navy "night kiosk" theme
  carried over from the first private build. A proper brand pass (name, logo,
  a lighter default theme for bright kitchens) belongs with the rename.

## Near term

- **The "click a button" deploy story.** PaaS templates (Render / Railway /
  Fly.io / a bare `docker run` one-liner) so a parent who has never self-hosted
  can be running a board in ten minutes. This is the front door for the
  community; it drives the rest of the UX (clear first-run, no assumptions).
- **Marketing site.** A small public site: what it is, screenshots, the
  security model in plain words, the quickstart, a link to the repo. The
  placeholder `my-super-behavior-dashboard.amazing` is a stand-in until the
  name is picked.
- **Managed option.** A hosted tier (we run it, you get a URL + your data),
  priced and scoped once the self-hosted door is proven. The app is already
  shaped for this: one instance per family, one file of state.

## Product

- **Multi-child / multi-board** in one instance (a household with two kids who
  share a TV).
- **SSO / OIDC** for the console (for families already on Keycloak/Authentik),
  kept optional so the no-infra story still works.
- **Editable risk factors & bands** in the console (the engine reads them from
  settings already; the UI is the gap).
- **Data export** (CSV / JSON) for sharing with a BCBA or therapist.
- **i18n.** English first; the copy is protocol-specific and localizable.
- **PWA polish** (installable, offline shell) for the kiosk.

## Known gaps (honest list)

- In-memory rate-limit/lockout state (a restart clears a lockout). Fine for a
  family-scale app; revisit if managed hosting grows.
- The security audit trail keeps 500 rows locally; export (CSV/JSON, alongside
  the board data export) is the natural next step.
- No per-IP allowlist; exposure is the deployer's decision by design.
  `X-Forwarded-For` is trusted for the per-IP limits — correct behind a proxy
  that sets it, and only fragments the limiter when spoofed open, which is a
  DoS-of-the-limiter, not an auth bypass.
- Single admin role (all parents share the one password). Multi-user with
  roles is not on the table yet — one instance, one family, one password.
