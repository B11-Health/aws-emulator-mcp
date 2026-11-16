"""Opt-in local Python order-handler verification in a one-shot Docker lab.

This is NOT an MCP tool. It intentionally executes developer-selected Python
inside the same *ephemeral network-disabled Docker container* as a synthetic
AWS Emulator process. Use only code you own/trust: Docker is not a security
guarantee against actively hostile native code. The caller supplies source
over stdin, never mounts the host repo and never forwards host AWS credentials.
"""
from __future__ import annotations

import contextlib
import hashlib
import inspect
import json
import os
import re
import sys

from aws_emulator_mcp import app_debug

MAX_SOURCE_BYTES = 20 * 1024
MAX_INPUT_BYTES = 26 * 1024
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
LIMITATIONS = (
    "One trusted local Python function submit_order(dynamodb,s3,sqs,*,"
    "table,bucket,queue_url,order); a synthetic repeated-order scenario; "
    "S3/DynamoDB/SQS SDK calls and cleanup in a one-shot network-disabled "
    "Docker container. NOT arbitrary application discovery, a full PR "
    "runner, hostile-code sandbox, real AWS validation, an IAM security "
    "test, or a transactional-outbox guarantee."
)


class LocalAppError(ValueError):
    pass


def validate(envelope):
    """Reject oversized or malformed source before evaluating anything."""
    if type(envelope) is not dict or set(envelope) != {
            "schemaVersion", "source", "sourceSha256"}:
        raise LocalAppError("Expected schemaVersion, source and sourceSha256 only")
    if type(envelope["schemaVersion"]) is not int or envelope["schemaVersion"] != 1:
        raise LocalAppError("Unsupported source envelope version")
    source = envelope["source"]
    digest = envelope["sourceSha256"]
    if not isinstance(source, str) or not isinstance(digest, str):
        raise LocalAppError("Source and hash must be strings")
    try:
        raw = source.encode("utf-8", errors="strict")
    except UnicodeError as exc:
        raise LocalAppError("Source must use valid UTF-8") from exc
    if not 1 <= len(raw) <= MAX_SOURCE_BYTES or b"\x00" in raw or not source.strip():
        raise LocalAppError("Expected a non-empty UTF-8 Python source (max 20 KiB)")
    if not SHA256.fullmatch(digest) or hashlib.sha256(raw).hexdigest() != digest:
        raise LocalAppError("Source SHA-256 mismatch")
    return source, digest


def read_source():
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise LocalAppError("Source envelope exceeds 26 KiB")
    try:
        data = json.loads(raw.decode("utf-8", "strict"),
                          parse_constant=lambda _: (_ for _ in ()).throw(
                              LocalAppError("Non-JSON constant")))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise LocalAppError("Source envelope is not valid UTF-8 JSON") from exc
    return validate(data)


def load_handler(source):
    """Execute only in the explicitly selected local Docker command."""
    if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
        raise LocalAppError("Local app verification requires the Docker lab")
    namespace = {"__name__": "_aws_mcp_local_order_handler"}
    compiled = compile(source, "<selected-local-handler>", "exec")
    # Ignore caller output: never stream untrusted log lines, test data or
    # exception messages into the public report or JSON stdout.
    with open(os.devnull, "w", encoding="utf-8") as sink:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            # Intentional trusted LOCAL source execution only, after a
            # user-initiated CLI command and verified isolated emulator.
            # No MCP/PR entrypoint accepts this envelope. Bandit B102
            # exception is scoped to this explicit opt-in extension.
            exec(compiled, namespace)  # nosec B102
    handler = namespace.get("submit_order")
    if not callable(handler):
        raise LocalAppError("Python source must define submit_order")
    try:
        inspect.signature(handler).bind(
            object(), object(), object(),
            table="synthetic", bucket="synthetic", queue_url="synthetic",
            order={"id": "synthetic"})
    except (TypeError, ValueError) as exc:
        raise LocalAppError("submit_order requires injected SDK clients and order arguments") from exc
    return handler


def execute(envelope):
    source, digest = validate(envelope)
    if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
        raise LocalAppError("Local source verification requires isolated Docker")
    from aws_emulator_mcp import server as aws
    doc = aws.doctor()
    if not doc.get("ready") or aws.identity().get("Account") != "000000000000":
        raise LocalAppError("Emulator account identity was not verified")
    handler = load_handler(source)
    # stdout/stderr redirected even during app calls, so caller logs cannot
    # corrupt JSON evidence or disclose secrets accidentally.
    with open(os.devnull, "w", encoding="utf-8") as sink:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = app_debug._run_variant("local", handler=handler)
    return {
        "schemaVersion": 1,
        "case": "local-order-handler",
        "passed": result["passed"],
        "accountVerified": result["verifiedAccount"] == "000000000000",
        "sourceSha256": digest,
        "emulatorVersion": result["emulatorVersion"],
        "observed": result["observed"],
        "assertions": result["assertions"],
        "cleanup": result["cleanup"],
        "error": result["error"],
        "limits": LIMITATIONS,
        "dataExposure": "Source, input order, SDK responses and handler logs omitted",
    }


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if args:
        print('{"schemaVersion":1,"passed":false,"error":"Invalid command arguments"}')
        return 2
    try:
        source, digest = read_source()
        result = execute({"schemaVersion": 1, "source": source, "sourceSha256": digest})
        print(json.dumps(result, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False))
        return 0 if result["passed"] else 1
    except Exception:
        # Absolutely no original exception string or filename on stdout.
        print('{"schemaVersion":1,"passed":false,"error":'
              '"Local Python handler validation or execution failed"}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
