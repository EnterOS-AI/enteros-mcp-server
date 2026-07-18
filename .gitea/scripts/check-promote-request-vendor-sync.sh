#!/usr/bin/env bash
# Fail-closed sync gate for the MCP reader's vendored promote-request contract.
# molecule-ai-sdk is the only editable cross-repository SSOT; this repository's
# copy exists solely for deterministic offline binding tests and must remain
# byte-identical to SDK main.
set -euo pipefail

SDK_BASE="${SDK_BASE:-https://git.moleculesai.app/molecule-ai/molecule-ai-sdk/raw/branch/main}"
SSOT_REL="${SSOT_CONTRACT_REL:-contracts/promote-request/promote-request.contract.json}"
LOCAL="${LOCAL_CONTRACT:-contracts/promote-request.contract.json}"
SSOT_URL="${SDK_BASE%/}/${SSOT_REL}"

if [ ! -f "$LOCAL" ]; then
  echo "::error::Vendored promote request contract $LOCAL is missing."
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

set +e
if [ -n "${CONTRACT_SYNC_TOKEN:-}" ]; then
  curl -fsS -A "curl/8.4.0" \
    -H @<(printf 'Authorization: token %s\n' "$CONTRACT_SYNC_TOKEN") \
    "$SSOT_URL" -o "$TMP"
else
  curl -fsS -A "curl/8.4.0" "$SSOT_URL" -o "$TMP"
fi
curl_status=$?
set -e
if [ "$curl_status" -ne 0 ]; then
  echo "::error::Failed to fetch SDK promote-request SSOT from $SSOT_URL (curl exit $curl_status). Fail-closed."
  exit 1
fi

if ! cmp -s "$TMP" "$LOCAL"; then
  echo "::error::$LOCAL drifted from the SDK promote-request SSOT."
  diff -u "$TMP" "$LOCAL" || true
  echo "Re-sync the SDK file verbatim over $LOCAL; never edit the mirror independently."
  exit 1
fi

echo "OK -- $LOCAL is byte-identical to the SDK promote-request SSOT."
