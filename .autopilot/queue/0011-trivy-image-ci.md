---
id: 0011
title: Trivy image scan in CI (report-only)
plan_ref: H
provider: evobox
sandbox: node
risk: low
max_iterations: 2
estimated_minutes: 20
---

## Goal

The image is built from a floating `node:22-slim` tag — when Node gets a CVE,
a family pulling `:latest` gets it silently fixed on our next push, but until
then nobody sees the exposure. Add a `scan` job to
`.github/workflows/ci.yml` that runs on the same condition as `image`
(push to main) and scans the freshly built GHCR image with Trivy.
**Report-only at first**: `severity: HIGH,CRITICAL`, `ignore-unfixed:
true`, `exit-code: 0`, output as a GitHub step summary + an annotation
(`type: eval`), so the project accumulates visibility without blocking
deploys on base-image noise. Keep the existing `test` and `image` jobs
untouched; `scan` needs `needs: [image]`.

## Files in scope

- .github/workflows/ci.yml

## Files explicitly out of scope

- Dockerfile, server.js, *.test.js, compose.yaml, docs/*

## Acceptance

```sh
node --test
node -e "
// structural check of the workflow without a yaml dep: assert the job is
// wired the way the goal describes.
const s = require('node:fs').readFileSync('.github/workflows/ci.yml', 'utf8');
if (!/scan:/.test(s)) throw new Error('missing scan job');
if (!/needs:\s*\[?image/.test(s.replace(/['\"]/g,''))) throw new Error('scan must need image');
if (!/trivy/i.test(s)) throw new Error('scan must run trivy');
if (!/exit-code:\s*0/.test(s)) throw new Error('scan must be report-only (exit-code 0) for now');
if (!/HIGH,CRITICAL/i.test(s)) throw new Error('scan should target HIGH,CRITICAL');
if (!/on:/.test(s) || !/pull_request:/.test(s)) throw new Error('must not have removed existing triggers');
console.log('trivy-ci-ok');
"
```

## Stop and ask if

- the `image` job's `docker/metadata-action` tags don't give the scan job a
  stable image reference to scan (it must scan the exact digest the image
  job pushed — if the metadata action doesn't expose it cleanly, use
  `ghcr.io/arbog/behavior-dashboard:latest` and say so in the job comment)
- you believe we should block on CRITICAL from day one rather than
  report-only (default: report-only; ask to flip it)

## Notes for the agent

- Use `aquasecurity/trivy-action@v0.28.0` (pin the major, not the exact
  patch, matching how this repo pins other actions — check the file for the
  house style first).
- The scan job needs `GITHUB_TOKEN` (already default) and GHCR login:
  reuse the same login step pattern as the `image` job.
- YAML validity is the bar; CI itself will prove it on the push.
