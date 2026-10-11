#!/usr/bin/env bash
# Regression tests for the package lifecycle's ignored-dist boundary.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
REBUILD="$ROOT/.gitea/scripts/rebuild-package-dist.sh"
EXPECTED_PREPACK="bash .gitea/scripts/rebuild-package-dist.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "PASS: $*"
}

actual_prepack=$(node -e '
  const pkg = require(process.argv[1]);
  process.stdout.write(pkg.scripts?.prepack ?? "");
' "$ROOT/package.json")
[ "$actual_prepack" = "$EXPECTED_PREPACK" ] \
  || fail "package.json must wire prepack to '$EXPECTED_PREPACK' (got '$actual_prepack')"
[ -f "$REBUILD" ] || fail "package dist rebuild script is missing: $REBUILD"
pass "package.json wires the clean dist rebuild into npm prepack"

package_version=$(node -p "require(process.argv[1]).version" "$ROOT/package.json")
lock_version=$(node -p "require(process.argv[1]).version" "$ROOT/package-lock.json")
lock_root_version=$(node -p "require(process.argv[1]).packages[''].version" "$ROOT/package-lock.json")
[ "$lock_version" = "$package_version" ] \
  || fail "package-lock.json version $lock_version does not match package.json $package_version"
[ "$lock_root_version" = "$package_version" ] \
  || fail "package-lock root version $lock_root_version does not match package.json $package_version"
pass "package and lockfile versions agree for reproducible npm ci input"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fixture="$tmp/repo"
mkdir -p "$fixture/.gitea/scripts" "$fixture/dist" "$tmp/bin"
cp "$REBUILD" "$fixture/.gitea/scripts/rebuild-package-dist.sh"
printf 'attacker-controlled ignored output\n' > "$fixture/dist/tampered.js"

cat > "$tmp/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 2 ] && [ "$1" = "run" ] && [ "$2" = "build:manifest" ] \
  || { echo "unexpected npm invocation: $*" >&2; exit 2; }
[ ! -e dist/tampered.js ] \
  || { echo "ignored dist survived until the build" >&2; exit 3; }
mkdir -p dist
printf 'fresh output\n' > dist/index.js
EOF
chmod +x "$tmp/bin/npm"

PATH="$tmp/bin:$PATH" bash "$fixture/.gitea/scripts/rebuild-package-dist.sh"
[ ! -e "$fixture/dist/tampered.js" ] \
  || fail "prepack rebuild left attacker-controlled ignored dist in place"
[ "$(cat "$fixture/dist/index.js")" = "fresh output" ] \
  || fail "prepack rebuild did not replace dist with fresh build output"
pass "prepack removes all ignored dist before rebuilding from source"

echo
echo "ALL PACKAGE BYTE-BOUNDARY CHECKS PASSED"
