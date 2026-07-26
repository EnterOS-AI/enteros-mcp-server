#!/usr/bin/env bash
# test_provenance_gate.sh — regression lock for the publish-provenance gate.
#
# Tests the load-bearing decision (drift = published - tagged) and the
# fail-closed direction-awareness in ISOLATION, with no network access. We
# re-implement the exact set algebra from provenance-gate.sh as a pure function
# of two string inputs (PUBLISHED, TAGS) and assert its outputs; this locks the
# logic that decides PASS vs DRIFT.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
GATE="$ROOT/.gitea/scripts/provenance-gate.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

[ -f "$GATE" ] || fail "provenance gate is missing: $GATE"
if grep -Eq 'LOCAL_TAGS=|git tag -l' "$GATE"; then
  fail "canonical drift must not trust or union unpushed local tags"
fi
pass "canonical drift membership is remote-only"

# Pure drift computation, identical to provenance-gate.sh step 4.
# Args: $1=published (space-sep) $2=tags (space-sep)
# Echoes the sorted drift set (published versions with no tag).
compute_drift() {
  local published="$1" tags="$2"
  local drift="" ver t tagged
  for ver in $published; do
    tagged="no"
    for t in $tags; do [ "$t" = "$ver" ] && { tagged="yes"; break; }; done
    [ "$tagged" = "yes" ] && continue
    drift="$drift $ver"
  done
  echo "$drift" | xargs 2>/dev/null || true
}

# T1: every published version is tagged; v1.1.0 is tagged but never published
# (benign). Expect: GREEN.
PUBLISHED="1.1.1 1.2.0 1.3.0 1.3.1 1.4.0 1.4.1 1.5.0 1.6.0 1.6.1"
TAGS="1.1.0 1.1.1 1.2.0 1.3.0 1.3.1 1.4.0 1.4.1 1.5.0 1.6.0 1.6.1"
D1=$(compute_drift "$PUBLISHED" "$TAGS")
[ -z "$D1" ] || fail "T1: real-world state should be clean, got drift: '$D1'"
pass "T1: every published version is tagged; tagged-only v1.1.0 is benign"

# T2: direction-awareness — a tag with no publish is BENIGN (v1.1.0 case).
D2=$(compute_drift "1.2.0" "1.1.0 1.2.0")
[ -z "$D2" ] || fail "T2: tagged-without-publish must be tolerated, got drift: '$D2'"
pass "T2: tagged-without-publish (v1.1.0) is benign"

# T3: an out-of-band publish is drift (the threat).
D3=$(compute_drift "1.6.0 1.6.1 1.7.0" "1.6.0 1.6.1")
[ "$D3" = "1.7.0" ] || fail "T3: new untagged 1.7.0 must be drift, got: '$D3'"
pass "T3: new untagged publish is flagged"

# T4: there is no allowlist escape hatch.
D4=$(compute_drift "1.5.0 1.6.0" "1.5.0")
[ "$D4" = "1.6.0" ] || fail "T4: untagged 1.6.0 must be drift, got: '$D4'"
pass "T4: untagged publish has no allowlist escape hatch"

# T5: retro-tagged v1.6.0/v1.6.1 is GREEN.
D5=$(compute_drift "1.6.0 1.6.1" "1.6.0 1.6.1")
[ -z "$D5" ] || fail "T5: retro-tagged 1.6.x should be clean, got: '$D5'"
pass "T5: retro-tagged 1.6.x is clean"

# T6: empty tag set with published versions (e.g. shallow checkout that also
# failed the remote fallback) — must surface drift, NOT silently pass. This is
# the fail-closed shape: an empty tag enumeration does not mean "all provenanced".
D6=$(compute_drift "1.5.0 1.6.0" "")
[ "$D6" = "1.5.0 1.6.0" ] || fail "T6: empty tags must flag every published version, got: '$D6'"
pass "T6: empty tag set flags every published version (fail-closed shape)"

echo
echo "ALL PROVENANCE-GATE CHECKS PASSED"
