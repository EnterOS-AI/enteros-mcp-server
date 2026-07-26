#!/usr/bin/env python3
"""Verify reviewed recovery attestations against Git and registry bytes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any
from urllib.parse import urlsplit


HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
TOP_LEVEL_KEYS = {"schema_version", "package", "registry", "recoveries"}
RECOVERY_KEYS = {
    "version",
    "tag",
    "canonical_commit",
    "source_tree",
    "tarball_url",
    "tarball_size",
    "tarball_sha256",
}


class VerificationError(Exception):
    """Expected fail-closed provenance validation error."""


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VerificationError(f"{label} is unreadable or invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise VerificationError(f"{label} must be a JSON object")
    return value


def exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        unexpected = sorted(actual - expected)
        raise VerificationError(
            f"{label} fields are invalid (missing={missing}, unexpected={unexpected})"
        )


def validate_inputs(
    attestations_path: Path, packument_path: Path
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    attestations = load_json(attestations_path, "attestation manifest")
    packument = load_json(packument_path, "registry packument")
    exact_keys(attestations, TOP_LEVEL_KEYS, "attestation manifest")

    if attestations["schema_version"] != 1:
        raise VerificationError("attestation manifest schema_version must be exactly 1")

    package = attestations["package"]
    registry = attestations["registry"]
    recoveries = attestations["recoveries"]
    if not isinstance(package, str) or not package:
        raise VerificationError("attestation package must be a non-empty string")
    if packument.get("name") != package:
        raise VerificationError(
            f"packument package {packument.get('name')!r} does not match {package!r}"
        )
    if not isinstance(registry, str) or not registry:
        raise VerificationError("attestation registry must be a non-empty string")
    if any(ord(character) <= 0x20 or ord(character) == 0x7F for character in registry):
        raise VerificationError("attestation registry must not contain whitespace or controls")
    registry_parts = urlsplit(registry)
    if (
        registry_parts.scheme != "https"
        or not registry_parts.netloc
        or registry_parts.username is not None
        or registry_parts.password is not None
        or registry_parts.query
        or registry_parts.fragment
    ):
        raise VerificationError("attestation registry must be a credential-free HTTPS URL")
    if not isinstance(recoveries, list) or not recoveries:
        raise VerificationError("attestation recoveries must be a non-empty array")

    versions = packument.get("versions")
    if not isinstance(versions, dict) or not versions:
        raise VerificationError("registry packument has no versions object")

    validated: dict[str, dict[str, Any]] = {}
    for index, recovery in enumerate(recoveries):
        label = f"recoveries[{index}]"
        if not isinstance(recovery, dict):
            raise VerificationError(f"{label} must be an object")
        exact_keys(recovery, RECOVERY_KEYS, label)

        version = recovery["version"]
        tag = recovery["tag"]
        commit = recovery["canonical_commit"]
        tree = recovery["source_tree"]
        tarball_url = recovery["tarball_url"]
        tarball_size = recovery["tarball_size"]
        tarball_sha256 = recovery["tarball_sha256"]

        if not isinstance(version, str) or not VERSION.fullmatch(version):
            raise VerificationError(f"{label}.version is not a supported exact version")
        if tag != f"v{version}":
            raise VerificationError(f"{label}.tag must be exactly v{version}")
        if not isinstance(commit, str) or not HEX40.fullmatch(commit):
            raise VerificationError(f"{label}.canonical_commit must be 40 lowercase hex")
        if not isinstance(tree, str) or not HEX40.fullmatch(tree):
            raise VerificationError(f"{label}.source_tree must be 40 lowercase hex")
        if not isinstance(tarball_sha256, str) or not HEX64.fullmatch(tarball_sha256):
            raise VerificationError(f"{label}.tarball_sha256 must be 64 lowercase hex")
        if (
            not isinstance(tarball_size, int)
            or isinstance(tarball_size, bool)
            or tarball_size <= 0
        ):
            raise VerificationError(f"{label}.tarball_size must be a positive integer")
        if not isinstance(tarball_url, str):
            raise VerificationError(f"{label}.tarball_url must be a string")
        if any(
            ord(character) <= 0x20 or ord(character) == 0x7F
            for character in tarball_url
        ):
            raise VerificationError(
                f"{label}.tarball_url must not contain whitespace or controls"
            )
        tarball_parts = urlsplit(tarball_url)
        if (
            tarball_parts.scheme != "https"
            or tarball_parts.netloc != registry_parts.netloc
            or tarball_parts.username is not None
            or tarball_parts.password is not None
            or tarball_parts.query
            or tarball_parts.fragment
            or not tarball_url.startswith(registry.rstrip("/") + "/")
        ):
            raise VerificationError(
                f"{label}.tarball_url must be a same-registry credential-free HTTPS URL"
            )
        if version in validated:
            raise VerificationError(f"duplicate recovery attestation for version {version}")

        published = versions.get(version)
        if not isinstance(published, dict):
            raise VerificationError(f"attested version {version} is absent from packument")
        dist = published.get("dist")
        actual_url = dist.get("tarball") if isinstance(dist, dict) else None
        if actual_url != tarball_url:
            raise VerificationError(
                f"version {version} registry tarball URL does not match the attestation"
            )
        validated[version] = recovery

    return attestations, validated


def git(repo: Path, *args: str) -> str:
    env = os.environ.copy()
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    if result.returncode != 0:
        raise VerificationError(
            f"git {' '.join(args)} failed (rc={result.returncode})"
        )
    return result.stdout.strip()


def verify(
    recovery: dict[str, Any], repo: Path, artifact: Path
) -> None:
    version = recovery["version"]
    tag = recovery["tag"]
    canonical_commit = recovery["canonical_commit"]
    source_tree = recovery["source_tree"]

    if not artifact.is_file():
        raise VerificationError(f"version {version} tarball is not a regular file")
    actual_size = artifact.stat().st_size
    if actual_size != recovery["tarball_size"]:
        raise VerificationError(
            f"version {version} tarball size {actual_size} does not match "
            f"{recovery['tarball_size']}"
        )
    actual_sha256 = hashlib.sha256(artifact.read_bytes()).hexdigest()
    if actual_sha256 != recovery["tarball_sha256"]:
        raise VerificationError(
            f"version {version} tarball SHA-256 does not match the attestation"
        )

    tag_commit = git(repo, "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}")
    if tag_commit != canonical_commit:
        raise VerificationError(
            f"tag {tag} resolves to {tag_commit} and does not resolve to canonical "
            f"commit {canonical_commit}"
        )
    resolved_commit = git(repo, "rev-parse", "--verify", f"{canonical_commit}^{{commit}}")
    if resolved_commit != canonical_commit:
        raise VerificationError(
            f"canonical commit {canonical_commit} did not resolve exactly"
        )
    actual_tree = git(repo, "rev-parse", "--verify", f"{canonical_commit}^{{tree}}")
    if actual_tree != source_tree:
        raise VerificationError(
            f"canonical commit {canonical_commit} source tree {actual_tree} does not "
            f"match {source_tree}"
        )


def parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--attestations", required=True, type=Path)
    common.add_argument("--packument", required=True, type=Path)

    result = argparse.ArgumentParser()
    subcommands = result.add_subparsers(dest="command", required=True)
    subcommands.add_parser("plan", parents=[common])
    verify_parser = subcommands.add_parser("verify", parents=[common])
    verify_parser.add_argument("--repo", required=True, type=Path)
    verify_parser.add_argument("--version", required=True)
    verify_parser.add_argument("--artifact", required=True, type=Path)
    return result


def main() -> int:
    args = parser().parse_args()
    _attestations, recoveries = validate_inputs(args.attestations, args.packument)
    if args.command == "plan":
        for version, recovery in recoveries.items():
            print(f"{version}\t{recovery['tarball_url']}")
        return 0

    recovery = recoveries.get(args.version)
    if recovery is None:
        raise VerificationError(
            f"version {args.version} has no reviewed recovery attestation"
        )
    verify(recovery, args.repo, args.artifact)
    print(
        "PUBLISHED-ARTIFACT PROVENANCE PASS: "
        f"{args.version} {recovery['tag']} -> {recovery['canonical_commit']} "
        f"sha256={recovery['tarball_sha256']}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationError as exc:
        print(f"PUBLISHED-ARTIFACT PROVENANCE FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
