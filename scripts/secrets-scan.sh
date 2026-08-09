#!/bin/sh
# The one secret scan. CI runs THIS script, and a maintainer runs THIS script - a bare gitleaks
# call is how the 2026-08-09 incident happened: a local binary older than 8.25 reads
# .gitleaks.toml, silently ignores every [[allowlists]] entry, and reports 12 leaks on a clean
# history. Same family as the CI action that once bundled 8.24.3 against the same config. One
# entry point plus a version assert makes the local run and the CI run the same check by
# construction, instead of by memo.
#
# Usage:
#   scripts/secrets-scan.sh          # every commit reachable from HEAD (what CI runs on push/PR)
#   scripts/secrets-scan.sh all      # every commit on every ref (what the weekly sweep runs)
#   scripts/secrets-scan.sh staged   # the staged index only - wire as a pre-commit hook
set -eu

# Single source of the pin: CI greps this line to install the same binary.
GITLEAKS_VERSION=8.30.1

ROOT=$(cd "$(dirname "$0")/.." && pwd)
have=$(gitleaks version 2>/dev/null || echo "not installed")
if [ "$have" != "$GITLEAKS_VERSION" ]; then
  echo "gitleaks $GITLEAKS_VERSION required, found: $have." >&2
  echo "An older binary silently ignores [[allowlists]] (8.25+ syntax) and floods a clean history with false leaks; a different newer one may drift the rule set. Install the pinned version." >&2
  exit 1
fi

MODE=${1:-head}
# --diff-merges=first-parent is load-bearing, not tidiness: gitleaks skips merge commits by
# default, so a secret introduced while RESOLVING A CONFLICT lives only in the merge and is
# invisible - measured on a purpose-built repo with a positive control. Passing --log-opts also
# REPLACES gitleaks' default walk (all refs, no merges), which is why the expected count below
# is derived per-mode instead of written down.
case "$MODE" in
  staged)
    # `gitleaks git --staged`, NOT the legacy `protect`: on 8.30 `protect --staged` exits 0
    # having scanned nothing - measured with a staged 40-hex canary, which makes a protect-based
    # pre-commit hook a green no-op. This form goes exit-2 on the same canary.
    exec gitleaks git --staged --redact --exit-code=2 \
      --config "$ROOT/.gitleaks.toml" "$ROOT"
    ;;
  # --all only in the weekly sweep, the one run that reaches branches nobody opened a PR for.
  # Push/PR runs must NOT use it: the expected count would then depend on how many stale
  # branches the remote carries, and the gate would go red for branch hygiene, not for a secret.
  all)  opts='--all --diff-merges=first-parent'; expected=$(git -C "$ROOT" rev-list --count --all) ;;
  head) opts='--diff-merges=first-parent';       expected=$(git -C "$ROOT" rev-list --count HEAD) ;;
  *) echo "usage: $0 [head|all|staged]" >&2; exit 2 ;;
esac

# Only a fact the truncation cannot restate catches truncation: on a shallow clone the count
# check below compares a truncated scan against a truncated range and agrees.
if [ "$(git -C "$ROOT" rev-parse --is-shallow-repository)" != false ]; then
  echo "the checkout is shallow - most of the history is not present to be scanned; fetch full history first" >&2
  exit 1
fi

log=$(mktemp)
# --config explicit and absolute: gitleaks finding no config scans with built-in rules and says
# nothing, so every allowlisted fixture reports as a leak. A wrong path exits 1 instead.
# NO pipeline around the scan: POSIX sh has no pipefail, and `gitleaks | tee` returns tee's zero
# over found leaks - measured, this script reported "no leaks" across a planted commit gitleaks
# had just flagged. The log is written directly and replayed after.
rc=0
gitleaks detect --redact --exit-code=2 --log-level=info \
  --config "$ROOT/.gitleaks.toml" --source "$ROOT" --log-opts="$opts" >"$log" 2>&1 || rc=$?
cat "$log" >&2
if [ "$rc" -eq 2 ]; then echo "LEAKS FOUND - see the findings above" >&2; exit 2; fi
if [ "$rc" -ne 0 ]; then echo "gitleaks failed (exit $rc) - the scan did not run to completion" >&2; exit "$rc"; fi

scanned=$(sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -oE '[0-9]+ commits scanned' | grep -oE '^[0-9]+' | tail -1 || true)
if [ -z "$scanned" ]; then
  echo "gitleaks printed no commit count - a scan that will not say what it covered proves nothing" >&2
  exit 1
fi
if [ "$scanned" -ne "$expected" ]; then
  echo "gitleaks scanned $scanned commits; the range holds $expected - the difference is unscanned history, and a green scan over part of a range is worse than no scan" >&2
  exit 1
fi
echo "gitleaks scanned $scanned of $expected commits, no leaks"
