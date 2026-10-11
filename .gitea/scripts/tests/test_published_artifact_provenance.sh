#!/usr/bin/env bash
# Regression tests for exact recovered-artifact/tag/source verification.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
VERIFIER="$ROOT/.gitea/scripts/verify-published-artifact.py"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

[ -f "$VERIFIER" ] || fail "published-artifact verifier is missing: $VERIFIER"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
artifact="$tmp/mcp-server-1.9.6.tgz"
attestations="$tmp/published-package-provenance.json"
packument="$tmp/packument.json"
tarball_url="https://registry.example.test/%40molecule-ai%2Fmcp-server/-/1.9.6/mcp-server-1.9.6.tgz"

git init -q -b main "$repo"
git -C "$repo" config user.name "Artifact Provenance Test"
git -C "$repo" config user.email "artifact-provenance@moleculesai.invalid"
printf 'reviewed source\n' > "$repo/source.txt"
git -C "$repo" add source.txt
git -C "$repo" commit -q -m "reviewed source"
source_commit=$(git -C "$repo" rev-parse HEAD)
source_tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
git -C "$repo" tag -a v1.9.6 -m "v1.9.6"

printf 'exact published artifact bytes\n' > "$artifact"
artifact_size=$(wc -c < "$artifact" | tr -d ' ')
artifact_sha256=$(python3 - "$artifact" <<'PY'
import hashlib
import pathlib
import sys

print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PY
)

cat > "$attestations" <<EOF
{
  "schema_version": 1,
  "package": "@molecule-ai/mcp-server",
  "registry": "https://registry.example.test",
  "recoveries": [
    {
      "version": "1.9.6",
      "tag": "v1.9.6",
      "canonical_commit": "$source_commit",
      "source_tree": "$source_tree",
      "tarball_url": "$tarball_url",
      "tarball_size": $artifact_size,
      "tarball_sha256": "$artifact_sha256"
    }
  ]
}
EOF

cat > "$packument" <<EOF
{
  "name": "@molecule-ai/mcp-server",
  "versions": {
    "1.9.6": {
      "dist": {
        "tarball": "$tarball_url"
      }
    }
  }
}
EOF

plan=$(python3 "$VERIFIER" plan \
  --attestations "$attestations" \
  --packument "$packument")
[ "$plan" = "$(printf '1.9.6\t%s' "$tarball_url")" ] \
  || fail "download plan did not emit the exact attested version/url: '$plan'"
pass "download plan accepts only the attested package/version/tarball URL"

GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  python3 "$VERIFIER" verify \
    --attestations "$attestations" \
    --packument "$packument" \
    --repo "$repo" \
    --version 1.9.6 \
    --artifact "$artifact" >/dev/null
pass "exact tag target, source tree, URL, size, and artifact SHA-256 pass"

expect_failure() {
  local name=$1
  local expected=$2
  shift 2
  local output rc
  set +e
  output=$("$@" 2>&1)
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "$name: verifier unexpectedly passed"
  case "$output" in
    *"$expected"*) ;;
    *) fail "$name: expected '$expected' in output, got: $output" ;;
  esac
  pass "$name"
}

printf 'tampered\n' >> "$artifact"
expect_failure \
  "tampered registry bytes fail closed" \
  "tarball size" \
  env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    python3 "$VERIFIER" verify \
      --attestations "$attestations" \
      --packument "$packument" \
      --repo "$repo" \
      --version 1.9.6 \
      --artifact "$artifact"
printf 'exact published artifact bytes\n' > "$artifact"

printf 'later source\n' >> "$repo/source.txt"
git -C "$repo" add source.txt
git -C "$repo" commit -q -m "later source"
later_commit=$(git -C "$repo" rev-parse HEAD)
later_tree=$(git -C "$repo" rev-parse 'HEAD^{tree}')
wrong_commit_attestations="$tmp/wrong-commit.json"
python3 - "$attestations" "$wrong_commit_attestations" "$later_commit" "$later_tree" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
data["recoveries"][0]["canonical_commit"] = sys.argv[3]
data["recoveries"][0]["source_tree"] = sys.argv[4]
pathlib.Path(sys.argv[2]).write_text(json.dumps(data))
PY
expect_failure \
  "tag pointing at a different commit fails closed" \
  "does not resolve to canonical commit" \
  env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    python3 "$VERIFIER" verify \
      --attestations "$wrong_commit_attestations" \
      --packument "$packument" \
      --repo "$repo" \
      --version 1.9.6 \
      --artifact "$artifact"

wrong_tree_attestations="$tmp/wrong-tree.json"
python3 - "$attestations" "$wrong_tree_attestations" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
data["recoveries"][0]["source_tree"] = "0" * 40
pathlib.Path(sys.argv[2]).write_text(json.dumps(data))
PY
expect_failure \
  "attested source-tree mismatch fails closed" \
  "source tree" \
  env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    python3 "$VERIFIER" verify \
      --attestations "$wrong_tree_attestations" \
      --packument "$packument" \
      --repo "$repo" \
      --version 1.9.6 \
      --artifact "$artifact"

wrong_url_packument="$tmp/wrong-url-packument.json"
python3 - "$packument" "$wrong_url_packument" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text())
data["versions"]["1.9.6"]["dist"]["tarball"] = "https://attacker.invalid/mcp-server-1.9.6.tgz"
pathlib.Path(sys.argv[2]).write_text(json.dumps(data))
PY
expect_failure \
  "registry tarball URL drift fails before download" \
  "tarball URL" \
  python3 "$VERIFIER" plan \
    --attestations "$attestations" \
    --packument "$wrong_url_packument"

echo
echo "ALL PUBLISHED-ARTIFACT PROVENANCE CHECKS PASSED"
