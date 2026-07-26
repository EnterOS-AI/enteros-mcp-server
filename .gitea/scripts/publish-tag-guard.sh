#!/usr/bin/env bash
# Defense-in-depth guard for ordinary `npm publish` from this repository.
#
# npm runs this through prepublishOnly. The canonical origin must already have
# v<npm_package_version>, and that tag must peel to the exact commit at HEAD.
# The script never creates, fetches, or moves a tag.
#
# This is not registry-level enforcement. npm --ignore-scripts, publishing a
# prebuilt tarball, a direct registry API request, or control of the configured
# origin can bypass a package lifecycle hook. Keep write:package credentials
# least-privilege and CI-only, and protect release tags against mutation.

set -uo pipefail

fail() {
  echo "PUBLISH-TAG-GUARD FAIL: $*" >&2
  exit 1
}

version=${npm_package_version:-}
[ -n "$version" ] \
  || fail "npm_package_version is empty; this guard must run through npm publish"

tag="v${version}"
tag_ref="refs/tags/${tag}"
peeled_ref="${tag_ref}^{}"

head_commit=$(git rev-parse --verify 'HEAD^{commit}' 2>/dev/null)
[ -n "$head_commit" ] \
  || fail "could not resolve the current Git HEAD commit"

publish_tree_state=$(git status --porcelain=v1 --untracked-files=all \
  --ignore-submodules=none 2>/dev/null)
publish_tree_rc=$?
[ "$publish_tree_rc" -eq 0 ] \
  || fail "could not inspect the Git publish tree (git status rc=$publish_tree_rc)"
[ -z "$publish_tree_state" ] \
  || fail "publish tree has tracked or non-ignored untracked changes; commit or remove them before publishing"

remote_refs=$(GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code origin \
  "$tag_ref" "$peeled_ref" 2>/dev/null)
remote_rc=$?
if [ "$remote_rc" -eq 2 ]; then
  fail "origin has no verifiable $tag_ref tag; push the approved immutable tag before publishing"
fi
[ "$remote_rc" -eq 0 ] \
  || fail "could not verify $tag_ref against origin (git ls-remote rc=$remote_rc)"

tag_commit=$(printf '%s\n' "$remote_refs" | awk \
  -v direct="$tag_ref" \
  -v peeled="$peeled_ref" '
    $2 == direct { direct_commit = $1 }
    $2 == peeled { peeled_commit = $1 }
    END {
      if (peeled_commit != "") {
        print peeled_commit
      } else if (direct_commit != "") {
        print direct_commit
      }
    }
  ')
[ -n "$tag_commit" ] \
  || fail "origin returned $tag_ref but it could not be resolved to a commit"

[ "$tag_commit" = "$head_commit" ] \
  || fail "origin tag $tag resolves to $tag_commit and does not resolve to exact HEAD $head_commit"

echo "PUBLISH-TAG-GUARD PASS: origin tag $tag resolves to exact HEAD $head_commit"
