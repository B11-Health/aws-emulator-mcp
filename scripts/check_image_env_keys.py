#!/usr/bin/env python3
"""Bounded offline image-ENV name gate. Values must never reach stdout/stderr.

Read only `docker image inspect --format '{{json .Config.Env}}'` on stdin.
This confirms a narrow Docker image configuration property, not the absence
of credentials in runtime mounts, layers, command-line arguments or source.
"""
from __future__ import annotations

import json
import re
import sys

MAX_BYTES = 64 * 1024
MAX_ROWS = 256
MAX_KEY = 128
NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z", re.ASCII)
SAFE_AWS_ENV_NAMES = frozenset({
    "AWS_EMULATOR_MCP_ISOLATED_LAB",
    "AWS_EMULATOR_PORT",
})
# Botocore's legacy Boto2Config provider reads BOTO_CONFIG. Legacy Boto
# clients also honor BOTO_PATH. Neither variable begins with AWS_/AMAZON_,
# so those prefixes alone do not cover credential-provider configuration.
# Reserve the BOTO_ namespace for explicit security review, not a generic
# environment allowlist. Compare uppercase to reject aliases in any casing.
CREDENTIAL_PROVIDER_PREFIXES = ("AWS_", "AMAZON_", "BOTO_")
MARKER = "AWS_EMULATOR_MCP_ISOLATED_LAB"


class UnsafeImageEnvironment(ValueError):
    """Do not include credentials, names, paths, or raw values in errors."""


def verify_env_keys(raw: bytes) -> None:
    """Reject credential-provider environment aliases and missing marker.

    Deliberately allow only the known fixed AWS_EMULATOR_* image variables.
    Any AWS_, AMAZON_, or BOTO_ name outside that allowlist requires review.
    The BOTO_CONFIG / BOTO_PATH names can select credential-bearing config.
    """
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_BYTES:
        raise UnsafeImageEnvironment()
    try:
        items = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError):
        raise UnsafeImageEnvironment() from None
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ROWS:
        raise UnsafeImageEnvironment()
    seen = set()
    has_marker = False
    for entry in items:
        if not isinstance(entry, str) or len(entry) > MAX_BYTES or "=" not in entry:
            raise UnsafeImageEnvironment()
        key, _, value = entry.partition("=")
        if len(key) > MAX_KEY or not NAME.fullmatch(key):
            raise UnsafeImageEnvironment()
        canonical = key.upper()
        if canonical in seen:
            raise UnsafeImageEnvironment()
        seen.add(canonical)
        # Linux Docker environment keys are case-sensitive: a lowercase
        # isolation marker does not satisfy the runtime's uppercase contract.
        if canonical in SAFE_AWS_ENV_NAMES and key != canonical:
            raise UnsafeImageEnvironment()
        if canonical.startswith(CREDENTIAL_PROVIDER_PREFIXES) and canonical not in SAFE_AWS_ENV_NAMES:
            raise UnsafeImageEnvironment()
        if canonical == MARKER:
            if value != "1":
                raise UnsafeImageEnvironment()
            has_marker = True
    if not has_marker:
        raise UnsafeImageEnvironment()


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        verify_env_keys(raw)
    except (UnsafeImageEnvironment, OSError):
        print("DOCKER_IMAGE_ENV_KEYS_GATE_FAILED", file=sys.stderr)
        return 1
    print("DOCKER_IMAGE_CREDENTIAL_ENV_KEYS_ABSENT")
    print("DOCKER_IMAGE_ISOLATED_MARKER_PRESENT")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
