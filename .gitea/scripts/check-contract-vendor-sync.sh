#!/usr/bin/env bash
# Vendor sync-check for the MCP-plugin delivery contract (core#3082).
#
# The producer-binding test (src/__tests__/contract-verb-binding.test.ts)
# reads a VENDORED copy of the shared contract so the unit test stays offline
# and deterministic. This script keeps that vendored copy honest: it fetches
# molecule-core's CANONICAL copy via the Gitea raw endpoint and byte-compares
# it against our local vendored file. RED if they differ — the vendored copy
# must be re-synced (copy core's verbatim) so the producer test validates
# against the SAME contract core's online/degraded gate uses.
#
# Mirrors molecule-core's mcp-plugin-delivery-contract-drift.yml (core <->
# template <-> runtime byte-identity), extended to the producer side.
#
# AUTH: molecule-core is PUBLIC, so its canonical contract is readable over the
# raw endpoint WITHOUT a token. CONTRACT_SYNC_TOKEN is therefore OPTIONAL — if
# set (rate-limit headroom, or if core is ever made private) it is sent as the
# Authorization header; if unset we fetch unauthenticated. Either way the check
# is FAIL-CLOSED on a fetch error (non-200 / network) and on byte drift, and it
# runs on EVERY context (incl. fork PRs) because no secret is required.
set -euo pipefail

API_ROOT="${API_ROOT:-https://git.moleculesai.app/api/v1}"
CORE_REPO="${CORE_REPO:-molecule-ai/molecule-core}"
CONTRACT_REL="contracts/mcp-plugin-delivery.contract.json"
LOCAL="${CONTRACT_REL}"
REF="${CORE_REF:-main}"

if [ ! -f "$LOCAL" ]; then
  echo "::error::Vendored contract $LOCAL is missing — it must be present for the producer-binding test."
  exit 1
fi

CANON_URL="${API_ROOT}/repos/${CORE_REPO}/raw/${CONTRACT_REL}?ref=${REF}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# core is public -> token optional; send it only if provided.
AUTH_ARGS=()
if [ -n "${CONTRACT_SYNC_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: token ${CONTRACT_SYNC_TOKEN}")
fi

set +e
curl -fsS "${AUTH_ARGS[@]}" "${CANON_URL}" -o "$TMP"
curl_status=$?
set -e
if [ "$curl_status" -ne 0 ]; then
  echo "::error::Failed to fetch core's canonical contract from ${CORE_REPO}@${REF} (curl exit $curl_status). Fail-closed."
  exit 1
fi

if diff -u "$TMP" "$LOCAL"; then
  echo "OK — vendored contract is byte-identical to molecule-core's canonical (${CORE_REPO}@${REF})."
else
  echo "::error::Vendored ${LOCAL} DRIFTED from molecule-core's canonical."
  echo "Re-sync: copy ${CORE_REPO}:${CONTRACT_REL} verbatim over ${LOCAL}, then re-run the producer-binding test."
  exit 1
fi
