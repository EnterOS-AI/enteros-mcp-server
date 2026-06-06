#!/usr/bin/env bash
# test_audit_force_merge.sh — regression lock for mcp-server audit-force-merge
# fail-closed behavior. Verifies schema validation paths via direct jq.

set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

[ -x "$(command -v jq)" ] || { echo "SKIP: jq not on PATH"; exit 0; }

validate_pr_schema() {
  jq -r '
    (.merged | type == "boolean") and
    (.merge_commit_sha | type == "string") and
    (.merged_by | type == "object") and (.merged_by.login | type == "string") and
    (.base | type == "object") and (.base.ref | type == "string") and
    (.head | type == "object") and (.head.sha | type == "string")
  '
}

validate_statuses_type() {
  jq -r '(.statuses | type) == "array"'
}

validate_required_checks_json() {
  local branch="$1"
  local json="$2"
  echo "$json" | jq -r --arg branch "$branch" 'has($branch) and (.[$branch] | type == "array")'
}

# PR schema tests
T1=$(echo '{"merged":true,"merge_commit_sha":"abc","merged_by":{"login":"u"},"base":{"ref":"main"},"head":{"sha":"def"}}' | validate_pr_schema)
[ "$T1" = "true" ] || fail "T1: valid payload should pass schema"
pass "T1: valid payload passes schema"

T2=$(echo '{"merged":"true","merge_commit_sha":"abc","merged_by":{"login":"u"},"base":{"ref":"main"},"head":{"sha":"def"}}' | validate_pr_schema)
[ "$T2" = "false" ] || fail "T2: merged as string should fail schema"
pass "T2: merged as string fails schema"

T3=$(echo '{"merge_commit_sha":"abc","merged_by":{"login":"u"},"base":{"ref":"main"},"head":{"sha":"def"}}' | validate_pr_schema)
[ "$T3" = "false" ] || fail "T3: missing merged should fail schema"
pass "T3: missing merged fails schema"

# Statuses type tests
T4=$(echo '{"statuses":[{"context":"c1","status":"success"}]}' | validate_statuses_type)
[ "$T4" = "true" ] || fail "T4: array statuses should pass"
pass "T4: array statuses passes"

T5=$(echo '{"statuses":null}' | validate_statuses_type)
[ "$T5" = "false" ] || fail "T5: null statuses should fail"
pass "T5: null statuses fails"

T6=$(echo '{}' | validate_statuses_type)
[ "$T6" = "false" ] || fail "T6: missing statuses should fail"
pass "T6: missing statuses fails"

# REQUIRED_CHECKS_JSON tests
T7=$(validate_required_checks_json "main" '{"main":["CI"]}')
[ "$T7" = "true" ] || fail "T7: existing array branch should pass"
pass "T7: existing array branch passes"

T8=$(validate_required_checks_json "staging" '{"main":["CI"]}')
[ "$T8" = "false" ] || fail "T8: missing branch should fail"
pass "T8: missing branch fails"

T9=$(validate_required_checks_json "main" '{"main":"CI"}')
[ "$T9" = "false" ] || fail "T9: string branch entry should fail"
pass "T9: string branch entry fails"

echo
echo "ALL AUDIT-FORCE-MERGE CHECKS PASSED"
