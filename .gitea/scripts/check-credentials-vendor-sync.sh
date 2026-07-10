#!/usr/bin/env bash
# Vendor sync-check for the ROOT-level credentials/privilege contract
# (molecule-ai-sdk contracts/credentials).
#
# The reader-binding test (src/__tests__/contract-credentials-binding.test.ts)
# reads a VENDORED copy of the credentials contract so the unit test stays
# offline and deterministic. This script keeps that vendored copy honest: it
# fetches molecule-ai-sdk's CANONICAL copy via the Gitea raw endpoint and
# byte-compares it against our local vendored file. RED if they differ — the
# vendored copy must be re-synced (copy the SDK's verbatim) so the reader test
# validates against the SAME contract the runtime forwarder (privileged_mcp_env,
# drift-gated in runtime#260) and the core setter (conciergePlatformMCPEnv,
# core#3716) are pinned to.
#
# Mirrors this repo's own check-contract-vendor-sync.sh (the verb contract),
# which in turn mirrors molecule-core's SDK-consumed contract check.
#
# AUTH: molecule-ai-sdk is PUBLIC, so its canonical contract is readable over
# the raw endpoint WITHOUT a token. CONTRACT_SYNC_TOKEN is therefore OPTIONAL —
# if set (rate-limit headroom, or if the SDK is ever made private) it is sent as
# the Authorization header; if unset we fetch unauthenticated. Either way the
# check is FAIL-CLOSED on a fetch error (non-200 / network) and on byte drift,
# and it runs on EVERY context (incl. fork PRs) because no secret is required.
set -euo pipefail

API_ROOT="${API_ROOT:-https://git.moleculesai.app/api/v1}"
SSOT_REPO="${SSOT_REPO:-molecule-ai/molecule-ai-sdk}"
SSOT_CONTRACT_REL="${SSOT_CONTRACT_REL:-contracts/credentials/credentials.contract.json}"
LOCAL="contracts/credentials.contract.json"
REF="${SSOT_REF:-main}"

if [ ! -f "$LOCAL" ]; then
  echo "::error::Vendored contract $LOCAL is missing — it must be present for the reader-binding test."
  exit 1
fi

CANON_URL="${API_ROOT}/repos/${SSOT_REPO}/raw/${SSOT_CONTRACT_REL}?ref=${REF}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# molecule-ai-sdk is public -> token optional; send it only if provided.
AUTH_ARGS=()
if [ -n "${CONTRACT_SYNC_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: token ${CONTRACT_SYNC_TOKEN}")
fi

set +e
curl -fsS "${AUTH_ARGS[@]}" "${CANON_URL}" -o "$TMP"
curl_status=$?
set -e
if [ "$curl_status" -ne 0 ]; then
  echo "::error::Failed to fetch SDK canonical contract from ${SSOT_REPO}:${SSOT_CONTRACT_REL}@${REF} (curl exit $curl_status). Fail-closed."
  exit 1
fi

if diff -u "$TMP" "$LOCAL"; then
  echo "OK — vendored contract is byte-identical to molecule-ai-sdk's canonical (${SSOT_REPO}:${SSOT_CONTRACT_REL}@${REF})."
else
  echo "::error::Vendored ${LOCAL} DRIFTED from molecule-ai-sdk's canonical."
  echo "Re-sync: copy ${SSOT_REPO}:${SSOT_CONTRACT_REL} verbatim over ${LOCAL}, then re-run the reader-binding test."
  exit 1
fi
