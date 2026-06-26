#!/usr/bin/env bash
# test_provenance_gate.sh — regression lock for the publish-provenance gate.
#
# Tests the load-bearing decision (drift = published - tagged - allowlist) and
# the fail-closed direction-awareness in ISOLATION, with no network access. We
# re-implement the exact set algebra from provenance-gate.sh as a pure function
# of three string inputs (PUBLISHED, TAGS, ALLOWLIST) and assert its outputs;
# this locks the logic that decides PASS vs DRIFT.

set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# Pure drift computation, identical to provenance-gate.sh step 3.
# Args: $1=published (space-sep) $2=tags (space-sep) $3=allowlist (space-sep)
# Echoes the sorted drift set (published versions with no tag and not allowed).
compute_drift() {
  local published="$1" tags="$2" allowlist="$3"
  local drift="" ver t a tagged allowed
  for ver in $published; do
    tagged="no"
    for t in $tags; do [ "$t" = "$ver" ] && { tagged="yes"; break; }; done
    [ "$tagged" = "yes" ] && continue
    allowed="no"
    for a in $allowlist; do [ "$a" = "$ver" ] && { allowed="yes"; break; }; done
    [ "$allowed" = "yes" ] && continue
    drift="$drift $ver"
  done
  echo "$drift" | xargs 2>/dev/null || true
}

ALLOW="1.6.0 1.6.1"

# T1: real-world state — every published version is tagged except allowlisted
# 1.6.0/1.6.1; v1.1.0 is tagged but never published (benign). Expect: GREEN.
PUBLISHED="1.1.1 1.2.0 1.3.0 1.3.1 1.4.0 1.4.1 1.5.0 1.6.0 1.6.1"
TAGS="1.1.0 1.1.1 1.2.0 1.3.0 1.3.1 1.4.0 1.4.1 1.5.0"
D1=$(compute_drift "$PUBLISHED" "$TAGS" "$ALLOW")
[ -z "$D1" ] || fail "T1: real-world state should be clean, got drift: '$D1'"
pass "T1: real-world state is clean (1.6.x allowlisted, v1.1.0 untolerated-publish ignored)"

# T2: direction-awareness — a tag with no publish is BENIGN (v1.1.0 case).
D2=$(compute_drift "1.2.0" "1.1.0 1.2.0" "")
[ -z "$D2" ] || fail "T2: tagged-without-publish must be tolerated, got drift: '$D2'"
pass "T2: tagged-without-publish (v1.1.0) is benign"

# T3: a NEW untagged publish is DRIFT even though 1.6.x is allowlisted
# (allowlist is frozen; it must not absorb future out-of-band publishes).
D3=$(compute_drift "1.6.0 1.6.1 1.7.0" "" "$ALLOW")
[ "$D3" = "1.7.0" ] || fail "T3: new untagged 1.7.0 must be drift, got: '$D3'"
pass "T3: new untagged publish (1.7.0) is flagged despite frozen 1.6.x allowlist"

# T4: an out-of-band publish with NO allowlist coverage is drift (the threat).
D4=$(compute_drift "1.5.0 1.6.0" "1.5.0" "")
[ "$D4" = "1.6.0" ] || fail "T4: untagged 1.6.0 with empty allowlist must be drift, got: '$D4'"
pass "T4: untagged publish with no allowlist coverage is flagged"

# T5: emptying the allowlist after retro-tagging v1.6.0/v1.6.1 is GREEN — the
# clean end-state the rollout aims for.
D5=$(compute_drift "1.6.0 1.6.1" "1.6.0 1.6.1" "")
[ -z "$D5" ] || fail "T5: retro-tagged 1.6.x with empty allowlist should be clean, got: '$D5'"
pass "T5: retro-tagged 1.6.x + empty allowlist is the clean end-state"

# T6: empty tag set with published versions (e.g. shallow checkout that also
# failed the remote fallback) — must surface drift, NOT silently pass. This is
# the fail-closed shape: an empty tag enumeration does not mean "all provenanced".
D6=$(compute_drift "1.5.0 1.6.0" "" "$ALLOW")
[ "$D6" = "1.5.0" ] || fail "T6: empty tags must flag non-allowlisted 1.5.0 as drift, got: '$D6'"
pass "T6: empty tag set flags non-allowlisted published versions (fail-closed shape)"

echo
echo "ALL PROVENANCE-GATE CHECKS PASSED"
