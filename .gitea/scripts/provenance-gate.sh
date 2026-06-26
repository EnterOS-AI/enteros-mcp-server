#!/usr/bin/env bash
# provenance-gate.sh — publish-provenance gate for @molecule-ai/mcp-server.
#
# WHAT THIS DEFENDS
#   The Gitea-hosted npm registry accepts `npm publish` from anyone holding a
#   Gitea token with write:package on org molecule-ai. There is NO server-side
#   coupling between a publish and a git tag, a CI run, a review, or branch
#   protection. So a human/agent can build locally (dist/ is gitignored), bump
#   package.json, and publish OUT OF BAND — skipping the tag-triggered
#   publish.yml workflow entirely. This already happened: 1.6.0 and 1.6.1 are
#   published with no matching v* git tag.
#
# WHAT THIS CHECKS
#   Every PUBLISHED version on the registry must have a matching v<version>
#   git tag. This catches out-of-band publishes (the threat above) because a
#   publish that skipped the workflow also skipped creating the v* tag.
#
# FAIL-CLOSED (mirrors publish.yml's empty/404 idiom)
#   - a published-but-untagged version (drift)                  -> exit 1
#   - the packument fetch is non-200 / empty / unparseable      -> exit 1
#   - the git tag enumeration fails                             -> exit 1
#   Never silently green on an infra error.
#
# DIRECTION-AWARE
#   Only PUBLISHED-without-tag is a violation. TAGGED-without-publish (e.g.
#   v1.1.0 is tagged but never published) is BENIGN and tolerated — a tag may
#   precede or skip a publish.
#
# ALLOWLIST (advisory-first rollout)
#   1.6.0 and 1.6.1 are pre-gate out-of-band publishes that predate this check.
#   They are subtracted from the drift set so the gate is GREEN at introduction
#   without retro-tagging history. DO NOT EXTEND THIS ALLOWLIST — new versions
#   must be tag-provenanced. The clean alternative is to retro-tag v1.6.0 /
#   v1.6.1 and empty the allowlist.
#
# ROLLOUT: advisory -> soak -> required.
#   Today this runs as a `continue-on-error: true` advisory job in ci.yml, so a
#   red does NOT block merges (the merge-queue reads required contexts from
#   branch protection, not job names, so an advisory job name cannot gate).
#   Promote to REQUIRED only AFTER (a) the 1.6.x cleanup (retro-tag or remove
#   the published 1.6.x), and (b) the publish-token lockdown (owner: revoke
#   every non-CI write:package token on org molecule-ai). At that point: remove
#   continue-on-error and add the "CI / provenance" context to branch
#   protection's status_check_contexts (owner-only BP edit).
#
# AUTH / SECRET
#   The packument is fetched from the Gitea npm registry. The raw packument
#   endpoint is unauthenticated-readable, but to be robust against the registry
#   enforcing read:package we send a bearer token IF one is present in the
#   environment as $PROVENANCE_REGISTRY_TOKEN. In CI this should be wired from a
#   read:package CI secret — see ci.yml (secrets.PROVENANCE_READ_PACKAGE_TOKEN).
#   The token is OPTIONAL here (the endpoint is currently public); the gate does
#   NOT hardcode any token and does NOT require write:package.

set -uo pipefail

PKG="@molecule-ai/mcp-server"
REGISTRY="https://git.moleculesai.app/api/packages/molecule-ai/npm"
PACKUMENT_URL="${REGISTRY}/${PKG}"

# Pre-gate out-of-band publishes that predate this check. DO NOT EXTEND.
ALLOWLIST="1.6.0 1.6.1"

fail() { echo "PROVENANCE-GATE FAIL: $*" >&2; exit 1; }

# --- 1. fetch the published-version set (the packument) ---------------------
# Optional bearer: only sent if PROVENANCE_REGISTRY_TOKEN is set & non-empty.
auth_args=()
if [ -n "${PROVENANCE_REGISTRY_TOKEN:-}" ]; then
  auth_args=(-H "Authorization: Bearer ${PROVENANCE_REGISTRY_TOKEN}")
fi

# -f makes curl exit non-zero on HTTP >=400; capture body + exit status.
PACKUMENT=$(curl -fsS "${auth_args[@]}" "$PACKUMENT_URL")
curl_rc=$?
if [ $curl_rc -ne 0 ]; then
  fail "could not fetch packument from $PACKUMENT_URL (curl rc=$curl_rc) -- failing closed instead of passing on an unreachable registry"
fi
if [ -z "$PACKUMENT" ]; then
  fail "packument fetch returned empty body from $PACKUMENT_URL -- failing closed"
fi

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

# --- 2. enumerate the v* git tag set ----------------------------------------
# CI checks out the repo, so local tags are authoritative. A shallow checkout
# may lack tags; fall back to the remote. Fail closed if BOTH yield nothing
# while there ARE published versions (an empty tag set with a non-empty publish
# set is itself a drift signal, not a reason to pass).
TAGS=$(git tag -l 'v*' 2>/dev/null | sed 's/^v//')
if [ -z "$TAGS" ]; then
  # Shallow checkout fallback: ask the origin remote directly.
  TAGS=$(git ls-remote --tags origin 'v*' 2>/dev/null \
    | sed -n 's#.*refs/tags/v\([^^{}]*\)$#\1#p')
fi
# A failed git tag enumeration (no git, no remote) leaves TAGS empty. We do NOT
# treat empty-tags as a pass: the drift computation below will flag every
# non-allowlisted published version, which is the correct fail-closed outcome.

# --- 3. compute drift = published - tagged - allowlist ----------------------
DRIFT=""
for ver in $PUBLISHED; do
  # tagged?
  tagged="no"
  for t in $TAGS; do
    if [ "$t" = "$ver" ]; then tagged="yes"; break; fi
  done
  [ "$tagged" = "yes" ] && continue
  # allowlisted?
  allowed="no"
  for a in $ALLOWLIST; do
    if [ "$a" = "$ver" ]; then allowed="yes"; break; fi
  done
  [ "$allowed" = "yes" ] && continue
  DRIFT="$DRIFT $ver"
done
DRIFT=$(echo "$DRIFT" | xargs 2>/dev/null || true)

if [ -n "$DRIFT" ]; then
  fail "published versions with NO matching v* git tag (out-of-band publish?): $DRIFT
  Each published version must have a v<version> git tag. If this is a legitimate
  publish, create the v<version> tag (the publish.yml workflow does this for
  CI-path publishes). Do NOT add to the allowlist -- it is frozen at the
  pre-gate 1.6.x set."
fi

echo "PROVENANCE-GATE PASS: every published version of $PKG has a matching v* git tag (allowlisted: $ALLOWLIST)"
