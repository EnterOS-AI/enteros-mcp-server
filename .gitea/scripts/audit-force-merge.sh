#!/usr/bin/env bash
# audit-force-merge — detect a §SOP-6 force-merge after PR close, emit
# `incident.force_merge` to stdout as structured JSON.
#
# Triggers on `pull_request_target: closed`.
# Required env: GITEA_TOKEN, GITEA_HOST, REPO, PR_NUMBER, REQUIRED_CHECKS

set -euo pipefail

: "${GITEA_TOKEN:?required}"
: "${GITEA_HOST:?required}"
: "${REPO:?required}"
: "${PR_NUMBER:?required}"
if [ -z "${REQUIRED_CHECKS_JSON:-}" ] && [ -z "${REQUIRED_CHECKS:-}" ]; then
  echo "::error::Either REQUIRED_CHECKS_JSON or REQUIRED_CHECKS must be set"
  exit 1
fi

OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
API="https://${GITEA_HOST}/api/v1"
AUTH="Authorization: token ${GITEA_TOKEN}"

# 1. Fetch the PR. Fail-closed: verify HTTP 200.
PR_TMP=$(mktemp)
PR_HTTP=$(curl -sS -o "$PR_TMP" -w '%{http_code}' -H "$AUTH" \
  "${API}/repos/${OWNER}/${NAME}/pulls/${PR_NUMBER}")
PR=$(cat "$PR_TMP")
rm -f "$PR_TMP"
if [ "$PR_HTTP" != "200" ]; then
  echo "::error::GET /pulls/${PR_NUMBER} returned HTTP ${PR_HTTP} — cannot evaluate merge state."
  exit 1
fi

PR_SCHEMA_OK=$(echo "$PR" | jq -r '
  (.merged | type == "boolean") and
  (.merge_commit_sha | type == "string") and
  (.merged_by | type == "object") and (.merged_by.login | type == "string") and
  (.base | type == "object") and (.base.ref | type == "string") and
  (.head | type == "object") and (.head.sha | type == "string")
')
if [ "$PR_SCHEMA_OK" != "true" ]; then
  echo "::error::GET /pulls/${PR_NUMBER} returned HTTP 200 but one or more required fields are missing, null, or of wrong type — cannot evaluate force-merge."
  exit 1
fi

MERGED=$(echo "$PR" | jq -r '.merged')
if [ "$MERGED" != "true" ]; then
  echo "::notice::PR #${PR_NUMBER} closed without merge — no audit emission."
  exit 0
fi

MERGE_SHA=$(echo "$PR" | jq -r '.merge_commit_sha')
MERGED_BY=$(echo "$PR" | jq -r '.merged_by.login')
TITLE=$(echo "$PR" | jq -r '.title // ""')
BASE_BRANCH=$(echo "$PR" | jq -r '.base.ref')
HEAD_SHA=$(echo "$PR" | jq -r '.head.sha')

# 2. Required status checks — branch-aware JSON dict takes precedence.
if [ -n "${REQUIRED_CHECKS_JSON:-}" ]; then
  _RC_JSON_OK=$(echo "$REQUIRED_CHECKS_JSON" | jq -r --arg branch "$BASE_BRANCH" '
    has($branch) and (.[$branch] | type == "array")
  ')
  if [ "$_RC_JSON_OK" != "true" ]; then
    echo "::error::REQUIRED_CHECKS_JSON missing or non-array entry for branch '$BASE_BRANCH' — cannot evaluate required checks."
    exit 1
  fi
  REQUIRED=$(echo "$REQUIRED_CHECKS_JSON" | jq -r --arg branch "$BASE_BRANCH" '.[$branch] | .[]')
else
  REQUIRED="$REQUIRED_CHECKS"
fi
if [ -z "${REQUIRED//[[:space:]]/}" ]; then
  echo "::notice::REQUIRED_CHECKS empty for branch '$BASE_BRANCH' — force-merge not applicable."
  exit 0
fi

# 3. Status-check state at the PR HEAD. Fail-closed: verify HTTP 200.
STATUS_TMP=$(mktemp)
STATUS_HTTP=$(curl -sS -o "$STATUS_TMP" -w '%{http_code}' -H "$AUTH" \
  "${API}/repos/${OWNER}/${NAME}/commits/${HEAD_SHA}/status")
STATUS=$(cat "$STATUS_TMP")
rm -f "$STATUS_TMP"
if [ "$STATUS_HTTP" != "200" ]; then
  echo "::error::GET /commits/${HEAD_SHA}/status returned HTTP ${STATUS_HTTP} — cannot evaluate required checks."
  exit 1
fi
if ! echo "$STATUS" | jq -e '(.statuses | type) == "array"' >/dev/null; then
  echo "::error::GET /commits/${HEAD_SHA}/status returned HTTP 200 but 'statuses' is missing or not an array — cannot evaluate required checks."
  exit 1
fi

declare -A CHECK_STATE
while IFS=$'\t' read -r ctx state; do
  [ -n "$ctx" ] && CHECK_STATE[$ctx]="$state"
done < <(echo "$STATUS" | jq -r '.statuses | .[] | "\(.context)\t\(.status)"')

# 4. For each required check, was it green at merge?
FAILED_CHECKS=()
while IFS= read -r req; do
  trimmed="${req#"${req%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  [ -z "$trimmed" ] && continue
  state="${CHECK_STATE[$trimmed]:-missing}"
  if [ "$state" != "success" ]; then
    FAILED_CHECKS+=("${trimmed}=${state}")
  fi
done <<< "$REQUIRED"

if [ "${#FAILED_CHECKS[@]}" -eq 0 ]; then
  echo "::notice::PR #${PR_NUMBER} merged with all required checks green — not a force-merge."
  exit 0
fi

# 5. Emit structured audit event.
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
FAILED_JSON=$(printf '%s\n' "${FAILED_CHECKS[@]}" | jq -R . | jq -s .)

jq -nc \
  --arg event_type "incident.force_merge" \
  --arg ts "$NOW" \
  --arg repo "$REPO" \
  --argjson pr "$PR_NUMBER" \
  --arg title "$TITLE" \
  --arg base "$BASE_BRANCH" \
  --arg merged_by "$MERGED_BY" \
  --arg merge_sha "$MERGE_SHA" \
  --argjson failed_checks "$FAILED_JSON" \
  '{event_type: $event_type, ts: $ts, repo: $repo, pr: $pr, title: $title,
    base_branch: $base, merged_by: $merged_by, merge_sha: $merge_sha,
    failed_checks: $failed_checks}'

echo "::warning::FORCE-MERGE detected on PR #${PR_NUMBER} by ${MERGED_BY}: ${#FAILED_CHECKS[@]} required check(s) not green at merge time."
