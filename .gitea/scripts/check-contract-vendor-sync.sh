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
# Mirrors molecule-core's mcp-plugin-delivery-contract-drift.yml (core ↔
# template ↔ runtime byte-identity), extended to the producer side.
#
# AUTH: CONTRACT_SYNC_TOKEN — a Gitea token with read access to molecule-core
# (read:repository scope). On a trusted context (push / non-fork PR / dispatch)
# a missing token fails CLOSED. On an untrusted fork PR it soft-skips (the fork
# cannot have repo secrets, and a vendored-copy drift will still be caught on
# the trusted post-merge / scheduled run).
set -euo pipefail

API_ROOT="${API_ROOT:-https://git.moleculesai.app/api/v1}"
CORE_REPO="${CORE_REPO:-molecule-ai/molecule-core}"
CONTRACT_REL="contracts/mcp-plugin-delivery.contract.json"
LOCAL="${CONTRACT_REL}"
IS_TRUSTED="${IS_TRUSTED:-true}"
REF="${CORE_REF:-main}"

if [ ! -f "$LOCAL" ]; then
  echo "::error::Vendored contract $LOCAL is missing — it must be present for the producer-binding test."
  exit 1
fi

if [ -z "${CONTRACT_SYNC_TOKEN:-}" ]; then
  if [ "$IS_TRUSTED" = "true" ]; then
    echo "::error::CONTRACT_SYNC_TOKEN secret missing on a trusted context — cannot verify the vendored contract against core's canonical."
    exit 1
  fi
  echo "::warning::CONTRACT_SYNC_TOKEN missing on an untrusted fork PR — skipping vendored-contract sync-check (it runs on the trusted post-merge / scheduled run)."
  exit 0
fi

CANON_URL="${API_ROOT}/repos/${CORE_REPO}/raw/${CONTRACT_REL}?ref=${REF}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

set +e
curl -fsS -H "Authorization: token ${CONTRACT_SYNC_TOKEN}" "${CANON_URL}" -o "$TMP"
curl_status=$?
set -e
if [ "$curl_status" -ne 0 ]; then
  echo "::error::Failed to fetch core's canonical contract from ${CORE_REPO}@${REF} (curl exit $curl_status)."
  exit 1
fi

if diff -u "$TMP" "$LOCAL"; then
  echo "OK — vendored contract is byte-identical to molecule-core's canonical (${CORE_REPO}@${REF})."
else
  echo "::error::Vendored ${LOCAL} DRIFTED from molecule-core's canonical."
  echo "Re-sync: copy ${CORE_REPO}:${CONTRACT_REL} verbatim over ${LOCAL}, then re-run the producer-binding test."
  exit 1
fi
