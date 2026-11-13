"""Reproducible, bounded AWS Emulator experiments for AI coding agents.

All scenarios use synthetic input and their own random resource names. They
never execute a supplied command, AWS account, endpoint, script or file path.
Results are machine-readable evidence of observed local calls, NOT AWS fidelity
or production security certification.
"""
from __future__ import annotations

import json
from pathlib import Path
import secrets
import sys
import time


CATALOG_FILE = Path(__file__).with_name("experiments.json")
SUPPORTED = ("order-recovery", "s3-recovery", "dynamodb-overwrite")


def catalog():
    data = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    if ([item.get("id") for item in data.get("experiments", [])] != list(SUPPORTED)
            or data.get("schemaVersion") != 1):
        raise aws.LocalError("Bundled AWS experiment catalog is invalid")
    return data


def _checked(condition, detail):
    if not condition:
        raise aws.LocalError(detail)
    return True


class Evidence:
    def __init__(self, experiment):
        spec = next(x for x in catalog()["experiments"] if x["id"] == experiment)
        self.started = time.perf_counter()
        self.data = {
            "schemaVersion": 1,
            "experiment": experiment,
            "title": spec["title"],
            "services": spec["services"],
            "passed": False,
            "source": "actual local AWS Emulator API responses",
            "verifiedAccount": None,
            "steps": [],
            "expectedFailures": [],
            "cleanup": [],
            "duration_ms": None,
            "error": None,
            "limitations": spec["caveat"],
        }

    def step(self, name, fn, check=None):
        begin = time.perf_counter()
        try:
            result = fn()
            if check is not None:
                _checked(check(result), name + " assertion failed")
        except Exception:
            self.data["steps"].append({"name": name, "passed": False,
                "duration_ms": round((time.perf_counter() - begin) * 1000, 1)})
            raise
        self.data["steps"].append({"name": name, "passed": True,
            "duration_ms": round((time.perf_counter() - begin) * 1000, 1)})
        return result

    def expected_failure(self, name, fn, fragment, code):
        begin = time.perf_counter()
        ok = False
        try:
            fn()
        except aws.LocalError as exc:
            ok = fragment in str(exc)
        self.data["expectedFailures"].append({"name": name, "passed": ok,
            "observed": code if ok else "unexpected response",
            "duration_ms": round((time.perf_counter() - begin) * 1000, 1)})
        _checked(ok, name + " did not produce its expected emulated error")

    def cleanup(self, name, fn):
        try:
            fn()
            self.data["cleanup"].append({"name": name, "passed": True})
        except Exception:
            self.data["cleanup"].append({"name": name, "passed": False})

    def verified_identity(self):
        self.step("verify emulator health", aws.health, lambda v: v.get("running") is True)
        who = self.step("verify isolated STS account", aws.identity,
                        lambda v: v.get("Account") == "000000000000")
        self.data["verifiedAccount"] = who["Account"]

    def finish(self, error=None):
        self.data["error"] = error
        self.data["duration_ms"] = round((time.perf_counter() - self.started) * 1000, 1)
        self.data["passed"] = (error is None and bool(self.data["steps"])
            and all(x["passed"] for x in self.data["steps"])
            and all(x["passed"] for x in self.data["expectedFailures"])
            and bool(self.data["cleanup"])
            and all(x["passed"] for x in self.data["cleanup"]))
        if not self.data["passed"] and self.data["error"] is None:
            self.data["error"] = "An evidence assertion or scoped cleanup failed"
        return self.data


def _error(exc):
    return str(exc)[:200] if isinstance(exc, (aws.LocalError, ValueError)) else "Unexpected local experiment failure"


def _s3_recovery():
    record = Evidence("s3-recovery")
    suffix = secrets.token_hex(5)
    bucket = "mcp-lab-objects-" + suffix
    key = "experiments/receipt.txt"
    body = "synthetic-receipt-" + suffix
    bucket_attempted = False
    object_attempted = False
    error = None
    try:
        record.verified_identity()
        bucket_attempted = True  # cleanup still attempts if the create request times out
        record.step("create isolated receipt bucket", lambda: aws.s3_create_bucket(bucket))
        record.expected_failure("missing S3 receipt returns 404",
            lambda: aws.s3_get_object(bucket, key), "HTTP 404", "HTTP 404")
        object_attempted = True
        record.step("repair by writing receipt", lambda: aws.s3_put_object(bucket, key, body))
        record.step("verify exact recovered text", lambda: aws.s3_get_object(bucket, key),
                    lambda result: result["text"] == body)
        record.step("verify object appears in bucket listing", lambda: aws.s3_list_objects(bucket),
                    lambda result: key in result["keys"])
    except Exception as exc:
        error = _error(exc)
    finally:
        if object_attempted:
            record.cleanup("delete experiment receipt", lambda: aws.s3_delete_object(bucket, key))
        if bucket_attempted:
            record.cleanup("delete experiment bucket", lambda: aws.s3_delete_bucket(bucket))
            record.cleanup("verify bucket absent after cleanup",
                lambda: _checked(bucket not in aws.s3_list_buckets()["buckets"],
                                 "Experiment bucket still exists"))
    return record.finish(error)


def _dynamodb_overwrite():
    record = Evidence("dynamodb-overwrite")
    suffix = secrets.token_hex(5)
    table = "mcp_lab_versions_" + suffix
    item_id = "sample-" + suffix
    attempted = False
    error = None
    try:
        record.verified_identity()
        attempted = True
        record.step("create experiment-only DynamoDB table", lambda: aws.dynamodb_create_table(table))
        record.step("write initial draft", lambda: aws.dynamodb_put_item(table, item_id, "draft"))
        record.step("verify draft before overwrite", lambda: aws.dynamodb_get_item(table, item_id),
                    lambda r: r.get("Item", {}).get("message", {}).get("S") == "draft")
        record.step("overwrite the same id with approved", lambda: aws.dynamodb_put_item(table, item_id, "approved"))
        record.step("verify last-write-wins value", lambda: aws.dynamodb_get_item(table, item_id),
                    lambda r: r.get("Item", {}).get("message", {}).get("S") == "approved")
    except Exception as exc:
        error = _error(exc)
    finally:
        if attempted:
            record.cleanup("delete experiment DynamoDB table", lambda: aws.dynamodb_delete_table(table))
            record.cleanup("verify table absent after cleanup", lambda: _checked(
                table not in aws.dynamodb_list_tables().get("TableNames", []),
                "Experiment table still exists"))
    return record.finish(error)


def _order_recovery():
    # Preserve legacy order-demo behavior, but normalize it for comparable reports.
    result = aws.emulator_order_demo()
    return {"schemaVersion": 1, "experiment": "order-recovery",
            "title": "Recover a broken three-service order workflow",
            "services": ["S3", "DynamoDB", "SQS"],
            "passed": result["passed"],
            "source": "actual local AWS Emulator API responses",
            "verifiedAccount": "000000000000" if result["passed"] else None,
            "steps": result["steps"],
            "expectedFailures": result["recovery"],
            "cleanup": result["cleanup"],
            "duration_ms": result["duration_ms"],
            "error": result["error"],
            "limitations": "Synthetic workflow, not a Lambda trigger or real payment processor"}


def run(experiment):
    if not isinstance(experiment, str) or experiment not in SUPPORTED:
        raise aws.LocalError("Unknown AWS experiment. Call lab_catalog or run: aws-emulator-mcp experiments")
    return {"order-recovery": _order_recovery,
            "s3-recovery": _s3_recovery,
            "dynamodb-overwrite": _dynamodb_overwrite}[experiment]()


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2 or args[0] != "run" or args[1] not in SUPPORTED:
        print("Usage: python -m aws_emulator_mcp.labs run <experiment-id>", file=sys.stderr)
        return 2
    result = run(args[1])
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["passed"] else 1


# Resolve the server only after all experiment functions exist, avoiding a cycle
# when a direct-file MCP server imports this module during tool registration.
from aws_emulator_mcp import server as aws

if __name__ == "__main__":
    raise SystemExit(main())
