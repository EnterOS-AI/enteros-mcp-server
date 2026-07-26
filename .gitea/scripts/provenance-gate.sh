#!/usr/bin/env bash
# provenance-gate.sh — required release-provenance gate for
# @molecule-ai/mcp-server.
#
# WHAT THIS DEFENDS
#   The Gitea-hosted npm registry accepts `npm publish` from anyone holding a
#   Gitea token with write:package on org molecule-ai. There is NO server-side
#   coupling between a publish and a git tag, a CI run, a review, or branch
#   protection. So a human/agent can build locally (dist/ is gitignored), bump
#   package.json, and publish OUT OF BAND — skipping the tag-triggered
#   publish.yml workflow entirely. This happened again for 1.9.6.
#
# WHAT THIS CHECKS
#   Every PUBLISHED version on the registry must have a matching v<version>
#   git tag. For a reviewed retroactive recovery recorded in
#   contracts/published-package-provenance.json, it additionally requires the
#   tag to resolve to the reviewed canonical commit/source tree and downloads
#   the exact registry tarball to verify its attested size and SHA-256.
#
# PROOF BOUNDARY
#   A tag by itself is NOT artifact-byte provenance: dist/ is gitignored but
#   npm-packed. The npm prepack lifecycle therefore deletes and rebuilds dist/
#   before an ordinary directory publish. Lifecycle hooks remain bypassable;
#   the real authorization boundary is a least-privilege CI-only write:package
#   credential. This gate never describes un-attested tagged artifacts as
#   byte-proven. The reviewed 1.9.6 recovery is the only exact-byte attestation
#   currently required here.
#
# FAIL-CLOSED (mirrors publish.yml's empty/404 idiom)
#   - a published-but-untagged version (drift)                  -> exit 1
#   - the packument fetch is non-200 / empty / unparseable      -> exit 1
#   - the git tag enumeration fails                             -> exit 1
#   Never silently green on an infra error.
#
# DIRECTION-AWARE TAG CHECK
#   Only PUBLISHED-without-tag is a violation. TAGGED-without-publish (e.g.
#   v1.1.0 is tagged but never published) is BENIGN and tolerated — a tag may
#   precede or skip a publish.
#
# REQUIRED
#   This script runs in an ordinary, non-continue-on-error CI job. Registry/tag
#   drift is a real red status, including during an active recovery incident.
#
# AUTH / SECRET
#   The packument is fetched from the Gitea npm registry. The raw packument
#   endpoint is unauthenticated-readable, but to be robust against the registry
#   enforcing read:package we send a bearer token IF one is present in the
#   environment as $PROVENANCE_REGISTRY_TOKEN. CI sources that optional token
#   from Infisical. The header is streamed to curl over stdin, never placed in
#   process arguments. The gate does NOT hardcode or require write:package.

set -uo pipefail

fail() { echo "PROVENANCE-GATE FAIL: $*" >&2; exit 1; }

PKG="@molecule-ai/mcp-server"
REGISTRY="https://git.moleculesai.app/api/packages/molecule-ai/npm"
PACKUMENT_URL="${REGISTRY}/${PKG}"
unset CDPATH
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) \
  || fail "could not resolve the provenance-gate script directory"
ROOT=$(cd "$SCRIPT_DIR/../.." && pwd) \
  || fail "could not resolve the repository root"
ATTESTATIONS="$ROOT/contracts/published-package-provenance.json"
VERIFIER="$ROOT/.gitea/scripts/verify-published-artifact.py"
TMP=$(mktemp -d) || fail "could not create a temporary verification directory"
[ -n "$TMP" ] && [ -d "$TMP" ] \
  || fail "temporary verification directory was not created"
trap 'rm -rf "$TMP"' EXIT
PACKUMENT_FILE="$TMP/packument.json"

registry_get() {
  local url=$1
  shift
  if [ -n "${PROVENANCE_REGISTRY_TOKEN:-}" ]; then
    case "$PROVENANCE_REGISTRY_TOKEN" in
      *$'\r'*|*$'\n'*)
        fail "PROVENANCE_REGISTRY_TOKEN contains a forbidden line break"
        ;;
    esac
    printf 'Authorization: Bearer %s\n' "$PROVENANCE_REGISTRY_TOKEN" \
      | curl -fSs --connect-timeout 10 --max-time 30 --max-filesize 10485760 \
          --proto '=https' --tlsv1.2 -A 'curl/8.4.0' -H @- \
          "$url" "$@"
  else
    curl -fSs --connect-timeout 10 --max-time 30 --max-filesize 10485760 \
      --proto '=https' --tlsv1.2 -A 'curl/8.4.0' \
      "$url" "$@"
  fi
}

# --- 1. fetch the published-version set (the packument) ---------------------
# -f makes curl exit non-zero on HTTP >=400; capture body + exit status.
PACKUMENT=$(registry_get "$PACKUMENT_URL")
curl_rc=$?
if [ $curl_rc -ne 0 ]; then
  fail "could not fetch packument from $PACKUMENT_URL (curl rc=$curl_rc) -- failing closed instead of passing on an unreachable registry"
fi
if [ -z "$PACKUMENT" ]; then
  fail "packument fetch returned empty body from $PACKUMENT_URL -- failing closed"
fi
printf '%s' "$PACKUMENT" > "$PACKUMENT_FILE"

# Parse the published versions out of `.versions | keys`. python3 is already a
# hard dep of CI (publish.yml uses it); fail closed if the JSON is unparseable
# or yields no versions.
PUBLISHED=$(printf '%s' "$PACKUMENT" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception as e:
    sys.stderr.write("unparseable packument JSON: %s\n" % e)
    sys.exit(3)
v = d.get("versions")
if not isinstance(v, dict) or not v:
    sys.stderr.write("packument has no .versions object\n")
    sys.exit(4)
print("\n".join(sorted(v.keys())))
')
parse_rc=$?
if [ $parse_rc -ne 0 ]; then
  fail "could not parse published versions from packument (rc=$parse_rc) -- failing closed"
fi
if [ -z "$PUBLISHED" ]; then
  fail "no published versions parsed from packument -- failing closed"
fi

# --- 2. validate reviewed recovery metadata before any tag decision ---------
[ -f "$ATTESTATIONS" ] \
  || fail "reviewed recovery attestation manifest is missing: $ATTESTATIONS"
[ -f "$VERIFIER" ] \
  || fail "published-artifact verifier is missing: $VERIFIER"

PLAN=$(python3 "$VERIFIER" plan \
  --attestations "$ATTESTATIONS" \
  --packument "$PACKUMENT_FILE")
plan_rc=$?
[ "$plan_rc" -eq 0 ] \
  || fail "could not validate reviewed recovery download plan (rc=$plan_rc)"
[ -n "$PLAN" ] \
  || fail "reviewed recovery download plan is unexpectedly empty"

# --- 3. enumerate the canonical-origin v* git tag set -----------------------
# Local tags are not provenance: an unpushed local v<version> must not suppress
# registry drift. Query canonical origin directly and fail closed if it cannot
# be enumerated.
TAGS=$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags origin 'v*' 2>/dev/null \
  | sed -n 's#.*refs/tags/v\([^^{}]*\)$#\1#p')
tags_rc=$?
[ "$tags_rc" -eq 0 ] \
  || fail "could not enumerate canonical origin v* tags (rc=$tags_rc)"
[ -n "$TAGS" ] || fail "canonical origin contains no v* tags"

# --- 4. compute drift = published - tagged ----------------------------------
DRIFT=""
for ver in $PUBLISHED; do
  # tagged?
  tagged="no"
  for t in $TAGS; do
    if [ "$t" = "$ver" ]; then tagged="yes"; break; fi
  done
  [ "$tagged" = "yes" ] && continue
  DRIFT="$DRIFT $ver"
done
DRIFT=$(echo "$DRIFT" | xargs 2>/dev/null || true)

if [ -n "$DRIFT" ]; then
  fail "published versions with NO matching v* git tag (out-of-band publish?): $DRIFT
  Each published version must have a v<version> git tag. If this is a legitimate
  recovery, bind the exact reviewed commit and registry bytes in
  contracts/published-package-provenance.json before creating the immutable tag.
  Do NOT add an allowlist."
fi

# --- 5. verify reviewed recovery tag/source/artifact attestations -----------
while IFS=$'\t' read -r version tarball_url; do
  [ -n "$version" ] && [ -n "$tarball_url" ] \
    || fail "reviewed recovery download plan emitted an empty version or URL"
  artifact="$TMP/mcp-server-${version}.tgz"
  registry_get "$tarball_url" -o "$artifact"
  artifact_rc=$?
  [ "$artifact_rc" -eq 0 ] \
    || fail "could not download attested tarball for $version (curl rc=$artifact_rc)"

  python3 "$VERIFIER" verify \
    --attestations "$ATTESTATIONS" \
    --packument "$PACKUMENT_FILE" \
    --repo "$ROOT" \
    --version "$version" \
    --artifact "$artifact" \
    || fail "exact published-artifact verification failed for $version"
done <<< "$PLAN"

echo "PROVENANCE-GATE PASS: every published version of $PKG has a matching v* git tag; reviewed recovery artifacts match their exact commit/tree/byte attestations"
