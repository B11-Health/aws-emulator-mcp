"""Deterministic failure/recovery evidence for a reviewed AWS-backed application.

Only bundled source executes. The fault is injected by an in-process SDK
wrapper: all non-faulted API calls use the isolated local AWS Emulator.
Neither code, endpoints, resource names nor scripts may be supplied by callers.
"""
from __future__ import annotations

import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys
import time

from aws_emulator_mcp import server as aws

ROOT = Path(__file__).resolve().parents[2] / "examples"
FRAGILE = ROOT / "order-intake" / "fixed" / "order_service.py"
RECOVERABLE = ROOT / "reliability-lab" / "recovery" / "order_service.py"
SCENARIOS = ("fragile-before-send", "recover-before-send", "recover-lost-ack", "compare")
LIMITATIONS = (
    "One fault is injected inside a local Python SDK wrapper, not by the AWS "
    "Emulator service or a live network. Real emulator calls persist synthetic "
    "S3/DynamoDB/SQS resources. The recovered producer is at-least-once; the "
    "single synthetic consumer-effect marker is idempotent, but neither broker "
    "exactly-once semantics nor production AWS fidelity, IAM, security or "
    "crash atomicity is established."
)


def catalog():
    """Expose only two packaged, reviewed source files to the coding agent."""
    fragile_source = FRAGILE.read_text(encoding="utf-8")
    recovery_source = RECOVERABLE.read_text(encoding="utf-8")
    diff = "".join(difflib.unified_diff(
        fragile_source.splitlines(keepends=True),
        recovery_source.splitlines(keepends=True),
        fromfile="a/examples/order-intake/fixed/order_service.py",
        tofile="b/examples/reliability-lab/recovery/order_service.py",
    ))
    return {
        "schemaVersion": 1,
        "fragileSource": fragile_source,
        "recoverableSource": recovery_source,
        "sourceDiff": diff,
        "title": "Prove retry recovery, lost acknowledgements and duplicate-safe effects",
        "scenarios": list(SCENARIOS),
        "services": ["DynamoDB", "S3", "SQS"],
        "sourcePaths": {
            "fragile": "examples/order-intake/fixed/order_service.py",
            "recoverable": "examples/reliability-lab/recovery/order_service.py",
        },
        "sourceSha256": {
            "fragile": hashlib.sha256(FRAGILE.read_bytes()).hexdigest(),
            "recoverable": hashlib.sha256(RECOVERABLE.read_bytes()).hexdigest(),
        },
        "faults": {
            "before-send": "Inject one synthetic RequestTimeout before SQS receives SendMessage",
            "lost-ack": "Forward actual SQS SendMessage, then inject RequestTimeout to simulate a lost response",
        },
        "invariants": [
            "A failed first send leaves recoverable order state pending",
            "A retry after pre-send failure publishes one fulfillment event",
            "A retry after response loss can publish two events with one stable eventId",
            "Conditional DynamoDB consumer marker records one effect despite duplicate deliveries",
            "Every uniquely named experiment resource is deleted",
        ],
        "instructions": (
            "Call failure_lab_run with scenario='compare' to reproduce the "
            "original missing-event failure and verify the two recovery cases. "
            "Inspect fragileSource, recoverableSource and sourceDiff. The lab runs only bundled reviewed sources; arbitrary code is not accepted."
        ),
        "limitations": LIMITATIONS,
    }


def _load_app(scenario):
    if scenario not in SCENARIOS[:-1]:
        raise aws.LocalError("Invalid reviewed reliability scenario")
    name = "fragile" if scenario == "fragile-before-send" else "recoverable"
    path = FRAGILE if name == "fragile" else RECOVERABLE
    spec = importlib.util.spec_from_file_location("_mcp_failure_lab_" + name, path)
    if spec is None or spec.loader is None:
        raise aws.LocalError("Bundled reliability application unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InjectSendFailure:
    """One-shot SDK-boundary fault, never a claim of actual emulator outage."""
    def __init__(self, client, *, forward_before_error=False):
        self.client = client
        self.forward_before_error = forward_before_error
        self.injected = 0
        self.forwarded = 0

    def send_message(self, **kwargs):
        if not self.injected:
            self.injected = 1
            if self.forward_before_error:
                self.client.send_message(**kwargs)
                self.forwarded += 1
            from botocore.exceptions import ClientError
            raise ClientError(
                {"Error": {"Code": "RequestTimeout",
                           "Message": "Synthetic one-shot SDK response failure"}},
                "SendMessage",
            )
        response = self.client.send_message(**kwargs)
        self.forwarded += 1
        return response


def _check(report, name, condition):
    report["assertions"].append({"name": name, "passed": bool(condition)})
    return condition


def _clean(report, name, fn):
    try:
        fn()
        report["cleanup"].append({"name": name, "passed": True})
    except Exception:
        report["cleanup"].append({"name": name, "passed": False})


def _assert(condition):
    if not condition:
        raise aws.LocalError("Expected resource cleanup was not observed")


def _status(table, order_id):
    row = aws.dynamodb_get_item(table, order_id).get("Item", {})
    return row.get("status", {}).get("S")


def _consume(queue, dynamodb, table, expected_order, *, dedupe):
    """Write consumer marker BEFORE acknowledging delivery; inspect every event."""
    from botocore.exceptions import ClientError

    received = []
    effect_count = 0
    duplicate_count = 0
    valid = True
    message_ids = set()
    for _ in range(8):
        batch = aws.sqs_receive_messages(queue)["messages"]
        if not batch:
            if received:
                break
            time.sleep(0.1)
            continue
        for message in batch:
            receipt = message.get("ReceiptHandle")
            message_id = message.get("MessageId")
            if not isinstance(receipt, str) or not receipt:
                raise aws.LocalError("Emulated SQS message is missing receipt")
            if not isinstance(message_id, str) or not message_id or message_id in message_ids:
                raise aws.LocalError("SQS returned invalid/repeated MessageId")
            message_ids.add(message_id)
            try:
                data = json.loads(message["Body"])
            except (TypeError, json.JSONDecodeError) as exc:
                raise aws.LocalError("Synthetic SQS payload was invalid JSON") from exc
            received.append(data)
            if dedupe:
                stable = "fulfillment:" + expected_order["id"]
                if (not isinstance(data, dict) or data.get("eventId") != stable
                        or data.get("order") != expected_order):
                    valid = False
                else:
                    try:
                        dynamodb.put_item(
                            TableName=table,
                            Item={"id": {"S": "processed#" + stable},
                                  "status": {"S": "consumed"}},
                            ConditionExpression="attribute_not_exists(#pk)",
                            ExpressionAttributeNames={"#pk": "id"},
                        )
                        effect_count += 1
                    except ClientError as exc:
                        if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                            raise
                        duplicate_count += 1
            # Acknowledge after the attempt to commit the marker. In this
            # synthetic demonstration no actual fulfillment side effect occurs.
            aws.sqs_delete_message(queue, receipt)
    return {"messages": len(received), "effectMarkers": effect_count,
            "duplicatesIgnored": duplicate_count, "eventBodiesValid": valid}


def _run_one(scenario):
    from aws_emulator_mcp import aws_sdk
    if scenario not in SCENARIOS[:-1]:
        raise aws.LocalError("Unknown failure-lab scenario")
    if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
        raise aws.LocalError("Failure Lab requires the isolated Docker runtime")
    clock = time.perf_counter()
    tag = secrets.token_hex(5)
    table = "mcp_fault_orders_" + tag
    bucket = "mcp-fault-receipts-" + tag
    queue = "mcp_fault_events_" + tag
    order = {"id": "order-" + tag, "sku": "local-widget", "quantity": 2}
    receipt_key = "receipts/" + order["id"] + ".json"
    receipt_body = json.dumps(order, sort_keys=True, separators=(",", ":"))
    started = {"table": False, "bucket": False, "queue": False, "receipt": False}
    fragile = scenario == "fragile-before-send"
    lost_ack = scenario == "recover-lost-ack"
    report = {
        "schemaVersion": 1, "scenario": scenario, "passed": False,
        "applicationRecovered": not fragile, "verifiedAccount": None,
        "emulatorVersion": None, "faultSource": "in-process SDK wrapper",
        "assertions": [], "cleanup": [], "observed": {
            "firstCallErrorCode": None, "statusAfterFault": None,
            "statusAfterRetry": None, "queueEvents": None,
            "consumerEffectMarkers": None, "duplicatesIgnored": None,
            "retryOutcome": None, "receiptMatches": None,
            "injectedFaults": None, "forwardedSqsCalls": None,
        }, "error": None, "durationMs": None, "limitations": LIMITATIONS,
    }
    try:
        identity = aws.identity()
        if identity.get("Account") != "000000000000":
            raise aws.LocalError("Refusing scenario outside isolated emulator account")
        report["verifiedAccount"] = identity["Account"]
        doctor = aws.doctor()
        if not doctor["ready"] or not doctor.get("emulator_version"):
            raise aws.LocalError("Local emulator doctor did not pass")
        report["emulatorVersion"] = doctor["emulator_version"]
        started["table"] = True
        aws.dynamodb_create_table(table)
        started["bucket"] = True
        aws.s3_create_bucket(bucket)
        started["queue"] = True
        queue_url = aws.sqs_create_queue(queue)["queue_url"]
        dynamodb = aws_sdk._client("dynamodb")[2]
        s3 = aws_sdk._client("s3")[2]
        sqs = aws_sdk._client("sqs")[2]
        app = _load_app(scenario)
        wrapper = InjectSendFailure(sqs, forward_before_error=lost_ack)
        from botocore.exceptions import ClientError
        started["receipt"] = True
        initial_error = None
        try:
            app.submit_order(dynamodb, s3, wrapper,
                             table=table, bucket=bucket,
                             queue_url=queue_url, order=order)
        except ClientError as exc:
            initial_error = exc.response.get("Error", {}).get("Code")
        state_after_fault = _status(table, order["id"])
        # Give the application its genuine second invocation with the same
        # logical order, exactly as a client might retry after a timeout.
        second = app.submit_order(dynamodb, s3, wrapper,
                                  table=table, bucket=bucket,
                                  queue_url=queue_url, order=order)
        state_after_retry = _status(table, order["id"])
        receipt = aws.s3_get_object(bucket, receipt_key)
        events = _consume(queue, dynamodb, table, order, dedupe=not fragile)
        report["observed"] = {
            "firstCallErrorCode": initial_error,
            "statusAfterFault": state_after_fault,
            "statusAfterRetry": state_after_retry,
            "queueEvents": events["messages"],
            "consumerEffectMarkers": events["effectMarkers"],
            "duplicatesIgnored": events["duplicatesIgnored"],
            "retryOutcome": second.get("status"),
            "receiptMatches": receipt.get("text") == receipt_body,
            "injectedFaults": wrapper.injected,
            "forwardedSqsCalls": wrapper.forwarded,
        }
        _check(report, "one synthetic timeout injected at SDK boundary",
               wrapper.injected == 1 and initial_error == "RequestTimeout")
        _check(report, "S3 receipt matches the submitted order",
               report["observed"]["receiptMatches"])
        _check(report, "retry did not accept a second logical order",
               second.get("accepted") is False)
        if fragile:
            _check(report, "prematurely marked queued before attempted SQS publish",
                   state_after_fault == "queued")
            _check(report, "retry suppressed by previous conditional write",
                   second.get("status") == "duplicate")
            _check(report, "missing fulfillment event reproduced",
                   state_after_retry == "queued" and events["messages"] == 0
                   and wrapper.forwarded == 0)
        else:
            _check(report, "pending work persisted after failed acknowledgement",
                   state_after_fault == "pending")
            _check(report, "retry completed pending work",
                   second.get("status") == "queued" and state_after_retry == "queued")
            _check(report, "event payload and stable event id independently verified",
                   events["eventBodiesValid"])
            if lost_ack:
                _check(report, "lost acknowledgement forwarded original SQS send",
                       wrapper.forwarded == 2 and events["messages"] == 2)
                _check(report, "consumer effect is recorded once despite duplicate messages",
                       events["effectMarkers"] == 1 and events["duplicatesIgnored"] == 1)
            else:
                _check(report, "retry after presend failure publishes one event",
                       wrapper.forwarded == 1 and events["messages"] == 1)
                _check(report, "consumer effect recorded exactly once",
                       events["effectMarkers"] == 1 and events["duplicatesIgnored"] == 0)
    except Exception as exc:
        # No arbitrary SDK exception messages or paths are exposed to the MCP.
        report["error"] = (str(exc)[:130] if isinstance(exc, aws.LocalError)
                           else type(exc).__name__[:80])
    finally:
        if started["queue"]:
            _clean(report, "delete isolated SQS queue",
                   lambda: aws.sqs_delete_queue(queue))
            _clean(report, "verify isolated queue absent",
                   lambda: _assert(queue not in aws.sqs_list_queues()["queues"]))
        if started["receipt"]:
            _clean(report, "delete synthetic S3 receipt",
                   lambda: aws.s3_delete_object(bucket, receipt_key))
        if started["bucket"]:
            _clean(report, "delete isolated S3 bucket",
                   lambda: aws.s3_delete_bucket(bucket))
            _clean(report, "verify S3 bucket absent",
                   lambda: _assert(bucket not in aws.s3_list_buckets()["buckets"]))
        if started["table"]:
            _clean(report, "delete isolated DynamoDB table",
                   lambda: aws.dynamodb_delete_table(table))
            _clean(report, "verify DynamoDB table absent",
                   lambda: _assert(table not in aws.dynamodb_list_tables().get("TableNames", [])))
    report["passed"] = (
        report["error"] is None and bool(report["assertions"])
        and all(x["passed"] for x in report["assertions"])
        and len(report["cleanup"]) == 7
        and all(x["passed"] for x in report["cleanup"])
    )
    if not report["passed"] and report["error"] is None:
        report["error"] = "A fault/recovery assertion or cleanup failed"
    report["durationMs"] = round((time.perf_counter() - clock) * 1000, 1)
    return report


def run(scenario="compare"):
    if not isinstance(scenario, str) or scenario not in SCENARIOS:
        raise aws.LocalError("Unknown failure-lab scenario: choose compare, fragile-before-send, recover-before-send, or recover-lost-ack")
    if scenario != "compare":
        data = _run_one(scenario)
        return {"schemaVersion": 1, "scenario": scenario,
                "passed": data["passed"], "result": data, "limitations": LIMITATIONS}
    broken = _run_one("fragile-before-send")
    recovered = _run_one("recover-before-send")
    lost_ack = _run_one("recover-lost-ack")
    return {
        "schemaVersion": 1, "scenario": "compare",
        "passed": all(item["passed"] for item in (broken, recovered, lost_ack)),
        "missingEventReproduced": broken["passed"],
        "presendRecoveryVerified": recovered["passed"],
        "lostAckDedupeVerified": lost_ack["passed"],
        "baseline": broken, "presendRecovery": recovered, "lostAckRecovery": lost_ack,
        "limitations": LIMITATIONS,
    }


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in SCENARIOS:
        print("Usage: python -m aws_emulator_mcp.failure_lab compare|fragile-before-send|recover-before-send|recover-lost-ack", file=sys.stderr)
        return 2
    result = run(args[0])
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
