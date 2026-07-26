#!/usr/bin/env python3
"""Static regressions for secret-safe release workflow process boundaries."""

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[3]
CI = (ROOT / ".gitea/workflows/ci.yml").read_text(encoding="utf-8")
PUBLISH = (ROOT / ".gitea/workflows/publish.yml").read_text(encoding="utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        print(f"FAIL: {message}", file=sys.stderr)
        raise SystemExit(1)
    print(f"PASS: {message}")


require(
    "INFISICAL_CI_" not in CI and "PROVENANCE_REGISTRY_TOKEN" not in CI,
    "public provenance CI stays tokenless",
)
require(
    not re.search(r"-d\s+.*INFISICAL_CI_CLIENT_SECRET", PUBLISH),
    "Infisical client secret is absent from curl arguments",
)
require(
    "--data-binary @-" in PUBLISH,
    "Infisical login JSON is streamed to curl stdin",
)
require(
    PUBLISH.count("env -u INFISICAL_CI_CLIENT_ID") >= 2
    and PUBLISH.count("-u INFISICAL_CI_CLIENT_SECRET") >= 2,
    "login curl and response parser do not inherit Infisical bootstrap credentials",
)
require(
    not re.search(r"-H\s+.*Authorization: Bearer .*\$TOK", PUBLISH),
    "Infisical access token is absent from curl arguments",
)
require(
    "-H @-" in PUBLISH,
    "Infisical access-token header is streamed to curl stdin",
)

login = PUBLISH.find("TOK=$(")
unset_bootstrap = PUBLISH.find(
    "unset INFISICAL_CI_CLIENT_ID INFISICAL_CI_CLIENT_SECRET"
)
read_secret = PUBLISH.find("read_secret()")
secret_fetch = PUBLISH.find("MOL_PACKAGE_TOKEN=$(read_secret")
unset_access = PUBLISH.find("unset TOK")
require(
    -1 not in (login, unset_bootstrap, read_secret, secret_fetch, unset_access)
    and login < unset_bootstrap < read_secret < secret_fetch < unset_access,
    "bootstrap and access credentials are dropped before later child processes",
)

require(
    not re.search(r"npm config set .*_authToken", PUBLISH),
    "npm auth token is absent from npm-config process arguments",
)
require(
    "'//git.moleculesai.app/api/packages/molecule-ai/npm/:_authToken="
    "${NODE_AUTH_TOKEN}'" in PUBLISH,
    "npm userconfig stores a literal NODE_AUTH_TOKEN placeholder",
)
require(
    "$GITHUB_ENV" not in PUBLISH
    and "export MOL_PACKAGE_TOKEN" not in PUBLISH
    and 'NODE_AUTH_TOKEN="$MOL_PACKAGE_TOKEN"' in PUBLISH,
    "package credential is exported only to the final npm process",
)

print("\nALL WORKFLOW SECRET-BOUNDARY CHECKS PASSED")
