#!/usr/bin/env bash
# Maintainer pre-PR check: fail if anything this branch adds matches the private denylist.
#
#   scripts/privacy-check.sh [base-ref]      # default base: origin/main
#
# The denylist is deliberately NOT in this repo (it is public, and the list is the very
# strings that must never appear in it). It is read from, in order:
#   $BEHAVIOR_DASHBOARD_DENYLIST, else ~/.config/behavior-dashboard/privacy-denylist
# One grep -E pattern per line, matched case-insensitively; '#' comments and blank lines ignored.
#
# Checks added lines (committed since the merge-base, plus uncommitted edits to tracked files)
# and the commit messages. Fails CLOSED: with no readable denylist it refuses rather than
# pass, because "could not check" must never read as "checked, clean".
#
# Exit: 0 clean | 1 hit(s), review before merging | 2 could not check
set -euo pipefail

deny="${BEHAVIOR_DASHBOARD_DENYLIST:-$HOME/.config/behavior-dashboard/privacy-denylist}"
base="${1:-origin/main}"

if [ ! -r "$deny" ]; then
  echo "privacy-check: no readable denylist at $deny; cannot verify, refusing." >&2
  exit 2
fi
patterns="$(grep -vE '^[[:space:]]*(#|$)' "$deny" || true)"
if [ -z "$patterns" ]; then
  echo "privacy-check: denylist $deny has no patterns; refusing." >&2
  exit 2
fi
git rev-parse --verify -q "$base^{commit}" >/dev/null || {
  echo "privacy-check: base ref '$base' not found; refusing." >&2
  exit 2
}

# Added lines only ('+' but not the '+++' file header), then commit messages.
scanned="$( { git diff --unified=0 "$base"...HEAD; git diff --unified=0 HEAD; } | grep -E '^\+[^+]' || true
            git log --format=%B "$base"..HEAD )"

hits="$(printf '%s\n' "$scanned" | grep -inE -e "$(printf '%s\n' "$patterns" | paste -sd'|')" || true)"
if [ -n "$hits" ]; then
  echo "privacy-check: $(printf '%s\n' "$hits" | wc -l) line(s) match the private denylist. Review each; a hit is a review, not a merge:" >&2
  printf '%s\n' "$hits" >&2
  exit 1
fi
echo "privacy-check: clean (vs $base)"
