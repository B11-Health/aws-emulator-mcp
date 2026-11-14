"""Application-level debugging case: reproduce a real failure and verify a patch.

Only the two bundled, reviewed Python application modules may execute. The
caller cannot submit a script, repository URL, endpoint, shell command or
source patch. Each variant runs against separate, randomly named AWS Emulator
resources in the network-isolated Docker lab, then verifies cleanup.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys
import time

ROOT = Path(__file__).resolve().parents[2] / "examples" / "order-intake"
SOURCES = {
    "buggy": ROOT / "buggy" / "order_service.py",
    "fixed": ROOT / "fixed" / "order_service.py",
}
PATCH = ROOT / "reference.patch"
VARIANTS = ("buggy", "fixed", "compare")
CASE = "duplicate-order-event"
LIMITATIONS = (
    "Tests one successful order followed by an identical retry with local "
    "DynamoDB/S3/SQS operations. Conditional writes prevent repeated publishes "
    "only when the initial operation completed; this is not a transactional "
    "outbox, a production IAM/security assessment, or full AWS API fidelity."
)


def catalog():
    """Return the bounded challenge and real, inspectable buggy source."""
    return {
        "schemaVersion": 1,
        "case": CASE,
        "title": "Stop duplicate fulfillment events on client retry",
        "language": "Python (botocore SDK clients)",
        "services": ["DynamoDB", "S3", "SQS"],
        "reproducer": "Submit the same synthetic order twice after the first succeeds",
        "invariants": [
            "Exactly one accepted submission for one logical order",
            "Exactly one SQS fulfillment event referencing that order",
            "The DynamoDB order row and S3 receipt match the submitted order",
            "Every experiment-created resource is removed",
        ],
        "sourcePath": "examples/order-intake/buggy/order_service.py",
        "buggySource": SOURCES["buggy"].read_text(encoding="utf-8"),
        "referencePatchPath": "examples/order-intake/reference.patch",
        "sourceSha256": {
            name: hashlib.sha256(path.read_bytes()).hexdigest()
            for name, path in SOURCES.items()
        },
        "availableVariants": list(VARIANTS),
        "instructions": (
            "Inspect the buggy source; use app_debug_run(variant='buggy') to "
            "reproduce the failure. Propose a minimal DynamoDB-conditional-write "
            "patch. app_debug_run(variant='compare') runs the packaged reference "
            "fix on fresh resources and returns the actual unified source diff. "
            "The tool does not execute arbitrary agent-supplied patches."
        ),
        "limitations": LIMITATIONS,
    }


def _load_app(variant):
    from aws_emulator_mcp import server as aws
    if variant not in SOURCES:
        raise aws.LocalError("Invalid packaged application variant")
    path = SOURCES[variant]
    spec = importlib.util.spec_from_file_location("_aws_mcp_order_" + variant, path)
    if spec is None or spec.loader is None:
        raise aws.LocalError("Packaged sample application cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _mark(report, name, passed):
    report["assertions"].append({"name": name, "passed": bool(passed)})
    return passed


def _cleanup(report, name, fn):
    try:
        fn()
        report["cleanup"].append({"name": name, "passed": True})
    except Exception:
        report["cleanup"].append({"name": name, "passed": False})


def _collect_messages(queue):
    """Independently consume and acknowledge all visible synthetic SQS events."""
    from aws_emulator_mcp import server as aws
    messages = []
    seen = set()
    for _ in range(6):
        batch = aws.sqs_receive_messages(queue)["messages"]
        for event in batch:
            token = event.get("ReceiptHandle")
            if not isinstance(token, str) or not token:
                raise aws.LocalError("SQS delivery has no receipt handle")
            msg_id = event.get("MessageId")
            if not isinstance(msg_id, str) or not msg_id or msg_id in seen:
                raise aws.LocalError("SQS delivered an invalid or repeated message ID")
            seen.add(msg_id)
            try:
                parsed = json.loads(event["Body"])
            except (TypeError, json.JSONDecodeError) as exc:
                raise aws.LocalError("SQS order event was not valid JSON") from exc
            messages.append(parsed)
            aws.sqs_delete_message(queue, token)
        if not batch and messages:
            # One extra poll establishes the queue is empty after ack.
            break
        time.sleep(0.12)
    return messages


def _run_variant(variant):
    """Execute a reviewed application module; never accept caller paths/code."""
    from aws_emulator_mcp import aws_sdk
    from aws_emulator_mcp import server as aws
    if variant not in SOURCES:
        raise aws.LocalError("Unknown app debugging variant")
    if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
        raise aws.LocalError("Application debugger requires isolated Docker lab")
    tick = time.perf_counter()
    suffix = secrets.token_hex(5)
    table = "mcp_app_orders_" + suffix
    bucket = "mcp-app-receipts-" + suffix
    queue = "mcp_app_events_" + suffix
    key = "receipts/order-" + suffix + ".json"
    order = {"id": "order-" + suffix, "sku": "local-widget", "quantity": 2}
    created = {"table": False, "bucket": False, "queue": False, "receipt": False}
    report = {
        "variant": variant,
        "passed": False,
        "verifiedAccount": None,
        "emulatorVersion": None,
        "assertions": [],
        "observed": {
            "acceptedSubmissions": None,
            "queueEvents": None,
            "duplicateSuppressed": None,
            "dbOrderPresent": None,
            "receiptMatches": None,
        },
        "cleanup": [],
        "error": None,
        "duration_ms": None,
    }
    try:
        ident = aws.identity()
        if ident.get("Account") != "000000000000":
            raise aws.LocalError("Refusing application run outside isolated emulator account")
        report["verifiedAccount"] = ident["Account"]
        report["emulatorVersion"] = aws.doctor().get("emulator_version")
        if not report["emulatorVersion"]:
            raise aws.LocalError("Could not establish local emulator version")

        # Mark an attempted create BEFORE making the request so cleanup still
        # attempts removal if a remote response is lost after resource creation.
        created["table"] = True
        aws.dynamodb_create_table(table)
        created["bucket"] = True
        aws.s3_create_bucket(bucket)
        created["queue"] = True
        queue_url = aws.sqs_create_queue(queue)["queue_url"]

        dynamodb = aws_sdk._client("dynamodb")[2]
        s3 = aws_sdk._client("s3")[2]
        sqs = aws_sdk._client("sqs")[2]
        app = _load_app(variant)
        created["receipt"] = True  # cleanup attempted even if the first write times out
        first = app.submit_order(dynamodb, s3, sqs,
                                 table=table, bucket=bucket,
                                 queue_url=queue_url, order=order)
        second = app.submit_order(dynamodb, s3, sqs,
                                  table=table, bucket=bucket,
                                  queue_url=queue_url, order=order)
        outcomes = [first, second]
        accepted = sum(x.get("accepted") is True for x in outcomes)
        rows = aws.dynamodb_get_item(table, order["id"])
        row = rows.get("Item", {})
        present = (row.get("sku", {}).get("S") == order["sku"]
                   and row.get("status", {}).get("S") == "queued")
        receipt = aws.s3_get_object(bucket, key)
        expected_body = json.dumps(order, sort_keys=True, separators=(",", ":"))
        matches = receipt["text"] == expected_body
        messages = _collect_messages(queue)
        message_match = all(x == order for x in messages)
        report["observed"] = {
            "acceptedSubmissions": accepted,
            "queueEvents": len(messages),
            "duplicateSuppressed": second.get("accepted") is False,
            "dbOrderPresent": present,
            "receiptMatches": matches,
        }
        _mark(report, "first submission accepted", first.get("accepted") is True)
        _mark(report, "duplicate retry rejected", second.get("accepted") is False)
        _mark(report, "exactly one accepted submission", accepted == 1)
        _mark(report, "exactly one SQS fulfillment event", len(messages) == 1)
        _mark(report, "event body matches logical order", bool(messages) and message_match)
        _mark(report, "DynamoDB row matches submitted order", present)
        _mark(report, "S3 receipt matches submitted order", matches)
    except Exception as exc:
        # Never leak arbitrary SDK exception text or local credentials/paths
        # into application debugging evidence.
        report["error"] = (
            str(exc)[:160] if isinstance(exc, (aws.LocalError, ValueError))
            else "Unexpected local app-debug failure"
        )
    finally:
        if created["queue"]:
            _cleanup(report, "delete isolated SQS queue",
                     lambda: aws.sqs_delete_queue(queue))
            _cleanup(report, "verify SQS queue absent", lambda: _require(
                queue not in aws.sqs_list_queues()["queues"], "SQS queue remains"))
        if created["receipt"]:
            _cleanup(report, "delete synthetic receipt",
                     lambda: aws.s3_delete_object(bucket, key))
        if created["bucket"]:
            _cleanup(report, "delete isolated S3 bucket",
                     lambda: aws.s3_delete_bucket(bucket))
            _cleanup(report, "verify S3 bucket absent", lambda: _require(
                bucket not in aws.s3_list_buckets()["buckets"], "S3 bucket remains"))
        if created["table"]:
            _cleanup(report, "delete isolated DynamoDB table",
                     lambda: aws.dynamodb_delete_table(table))
            _cleanup(report, "verify DynamoDB table absent", lambda: _require(
                table not in aws.dynamodb_list_tables().get("TableNames", []),
                "DynamoDB table remains"))
    checks = report["assertions"]
    report["passed"] = (
        report["error"] is None and len(checks) == 7
        and all(item["passed"] for item in checks)
        and bool(report["cleanup"])
        and all(item["passed"] for item in report["cleanup"])
    )
    if not report["passed"] and report["error"] is None:
        report["error"] = "A duplicate-order invariant or resource cleanup failed"
    report["duration_ms"] = round((time.perf_counter() - tick) * 1000, 1)
    return report


def _require(condition, explanation):
    from aws_emulator_mcp import server as aws
    if not condition:
        raise aws.LocalError(explanation)


def run(variant="compare"):
    """Reproduce bug and prove the shipped patch without user-supplied code."""
    from aws_emulator_mcp import server as aws
    if not isinstance(variant, str) or variant not in VARIANTS:
        raise aws.LocalError("Unknown packaged app-debug variant: choose buggy, fixed, or compare")
    if variant != "compare":
        evidence = _run_variant(variant)
        return {
            "schemaVersion": 1,
            "case": CASE,
            "variant": variant,
            "passed": evidence["passed"],
            "result": evidence,
            "limitations": LIMITATIONS,
        }
    before = _run_variant("buggy")
    after = _run_variant("fixed")
    bug_reproduced = (
        before["error"] == "A duplicate-order invariant or resource cleanup failed"
        and before["observed"]["acceptedSubmissions"] == 2
        and before["observed"]["queueEvents"] == 2
        and not before["observed"]["duplicateSuppressed"]
        and all(c["passed"] for c in before["cleanup"])
        and any(not a["passed"] for a in before["assertions"])
    )
    fixed_verified = after["passed"] and after["observed"]["acceptedSubmissions"] == 1 \
        and after["observed"]["queueEvents"] == 1 \
        and after["observed"]["duplicateSuppressed"]
    patch = PATCH.read_text(encoding="utf-8")
    return {
        "schemaVersion": 1,
        "case": CASE,
        "variant": "compare",
        "passed": bug_reproduced and fixed_verified,
        "bugReproduced": bug_reproduced,
        "referenceFixVerified": fixed_verified,
        "before": before,
        "after": after,
        "emulatorVersion": (before.get("emulatorVersion")
                            if before.get("emulatorVersion") == after.get("emulatorVersion")
                            else "mixed-or-unverified"),
        "referencePatch": patch,
        "referencePatchSha256": hashlib.sha256(patch.encode("utf-8")).hexdigest(),
        "sourcePaths": {
            "buggy": "examples/order-intake/buggy/order_service.py",
            "fixed": "examples/order-intake/fixed/order_service.py",
        },
        "limitations": LIMITATIONS,
    }


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in VARIANTS:
        print("Usage: python -m aws_emulator_mcp.app_debug buggy|fixed|compare",
              file=sys.stderr)
        return 2
    evidence = run(args[0])
    print(json.dumps(evidence, separators=(",", ":"), ensure_ascii=False))
    return 0 if evidence["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
