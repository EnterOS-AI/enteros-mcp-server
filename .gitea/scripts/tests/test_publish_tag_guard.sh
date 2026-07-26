#!/usr/bin/env bash
# Regression tests for the npm prepublishOnly tag/HEAD guard.
#
# Uses only local Git repositories. No registry or network access is required.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
GUARD="$ROOT/.gitea/scripts/publish-tag-guard.sh"
EXPECTED_HOOK="bash .gitea/scripts/publish-tag-guard.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

actual_hook=$(node -e '
  const pkg = require(process.argv[1]);
  process.stdout.write(pkg.scripts?.prepublishOnly ?? "");
' "$ROOT/package.json")
[ "$actual_hook" = "$EXPECTED_HOOK" ] \
  || fail "package.json must wire prepublishOnly to '$EXPECTED_HOOK' (got '$actual_hook')"
[ -f "$GUARD" ] || fail "publish guard is missing: $GUARD"
pass "package.json wires the npm prepublishOnly lifecycle guard"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
origin="$tmp/origin.git"
repo="$tmp/publisher"

git init -q --bare "$origin"
git init -q -b main "$repo"
git -C "$repo" config user.name "Publish Guard Test"
git -C "$repo" config user.email "publish-guard-test@moleculesai.invalid"
printf 'first\n' > "$repo/state.txt"
printf 'dist/\n' > "$repo/.gitignore"
git -C "$repo" add state.txt .gitignore
git -C "$repo" commit -q -m "first"
git -C "$repo" remote add origin "$origin"
git -C "$repo" push -q -u origin main

expect_guard_failure() {
  local name=$1
  local version=$2
  local expected=$3
  local output rc

  set +e
  if [ "$version" = "__UNSET__" ]; then
    output=$(cd "$repo" && env -u npm_package_version bash "$GUARD" 2>&1)
    rc=$?
  else
    output=$(cd "$repo" && npm_package_version="$version" bash "$GUARD" 2>&1)
    rc=$?
  fi
  set -e

  [ "$rc" -ne 0 ] || fail "$name: guard unexpectedly passed"
  case "$output" in
    *"$expected"*) ;;
    *) fail "$name: expected '$expected' in output, got: $output" ;;
  esac
  pass "$name"
}

expect_guard_pass() {
  local name=$1
  local version=$2
  local output

  output=$(cd "$repo" && npm_package_version="$version" bash "$GUARD" 2>&1) \
    || fail "$name: guard unexpectedly failed: $output"
  case "$output" in
    *"PUBLISH-TAG-GUARD PASS"*) ;;
    *) fail "$name: expected a pass marker, got: $output" ;;
  esac
  pass "$name"
}

expect_guard_failure \
  "missing npm lifecycle version fails closed" \
  "__UNSET__" \
  "npm_package_version is empty"

git -C "$repo" tag v1.0.0
expect_guard_failure \
  "a local-only tag does not establish canonical provenance" \
  "1.0.0" \
  "origin has no verifiable refs/tags/v1.0.0 tag"

git -C "$repo" push -q origin refs/tags/v1.0.0
git -C "$repo" tag -d v1.0.0 >/dev/null
printf 'second\n' >> "$repo/state.txt"
git -C "$repo" add state.txt
git -C "$repo" commit -q -m "second"
git -C "$repo" push -q origin main
expect_guard_failure \
  "a canonical tag on another commit does not match HEAD" \
  "1.0.0" \
  "does not resolve to exact HEAD"

git -C "$repo" tag v1.0.1
git -C "$repo" push -q origin refs/tags/v1.0.1
git -C "$repo" tag -d v1.0.1 >/dev/null
expect_guard_pass \
  "a canonical lightweight tag at HEAD passes without a local tag" \
  "1.0.1"

printf 'unstaged\n' >> "$repo/state.txt"
expect_guard_failure \
  "unstaged tracked package content fails closed" \
  "1.0.1" \
  "publish tree has tracked or non-ignored untracked changes"
git -C "$repo" restore state.txt

printf 'staged\n' >> "$repo/state.txt"
git -C "$repo" add state.txt
expect_guard_failure \
  "staged tracked package content fails closed" \
  "1.0.1" \
  "publish tree has tracked or non-ignored untracked changes"
git -C "$repo" restore --staged state.txt
git -C "$repo" restore state.txt

printf 'untracked\n' > "$repo/untracked.txt"
expect_guard_failure \
  "non-ignored untracked package content fails closed" \
  "1.0.1" \
  "publish tree has tracked or non-ignored untracked changes"
unlink "$repo/untracked.txt"

mkdir -p "$repo/dist"
printf 'generated\n' > "$repo/dist/generated.js"
expect_guard_pass \
  "ignored build output remains publishable" \
  "1.0.1"

git -C "$repo" tag -a v1.0.2 -m "v1.0.2"
git -C "$repo" push -q origin refs/tags/v1.0.2
git -C "$repo" tag -d v1.0.2 >/dev/null
expect_guard_pass \
  "a canonical annotated tag peeled to HEAD passes without a local tag" \
  "1.0.2"

git -C "$repo" tag -a v1.0.3 -m "v1.0.3"
git -C "$repo" push -q origin refs/tags/v1.0.3
git -C "$repo" tag -d v1.0.3 >/dev/null
printf 'third\n' >> "$repo/state.txt"
git -C "$repo" add state.txt
git -C "$repo" commit -q -m "third"
git -C "$repo" push -q origin main
expect_guard_failure \
  "a canonical annotated tag on another commit does not match HEAD" \
  "1.0.3" \
  "does not resolve to exact HEAD"

git -C "$repo" remote set-url origin "$tmp/unreachable-origin.git"
expect_guard_failure \
  "an unreachable canonical origin fails closed" \
  "1.0.3" \
  "could not verify refs/tags/v1.0.3 against origin"

echo
echo "ALL PUBLISH-TAG-GUARD CHECKS PASSED"
