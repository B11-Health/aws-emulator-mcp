"""Tests for the genuine sample app, reference patch, and fail-closed runner."""
from difflib import unified_diff
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from aws_emulator_mcp import app_debug, server as aws


class FakeClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}
        super().__init__(code)


class FakeDynamo:
    def __init__(self):
        self.items = {}
        self.calls = []
        self.error_code = None

    def put_item(self, **kwargs):
        self.calls.append(kwargs)
        if self.error_code:
            raise FakeClientError(self.error_code)
        key = kwargs["Item"]["id"]["S"]
        if kwargs.get("ConditionExpression") and key in self.items:
            raise FakeClientError("ConditionalCheckFailedException")
        self.items[key] = kwargs["Item"]


class FakeS3:
    def __init__(self):
        self.events = []

    def put_object(self, **kwargs):
        self.events.append(kwargs)


class FakeSQS:
    def __init__(self):
        self.events = []

    def send_message(self, **kwargs):
        self.events.append(kwargs)


def load_fixed():
    botocore = types.ModuleType("botocore")
    botocore.__path__ = []
    errors = types.ModuleType("botocore.exceptions")
    errors.ClientError = FakeClientError
    botocore.exceptions = errors
    # Real botocore is installed in the Docker acceptance test; fake only the
    # SDK exception import for dependency-free Windows/Python unit tests.
    with patch.dict(sys.modules, {"botocore": botocore, "botocore.exceptions": errors}):
        return app_debug._load_app("fixed")


class AppDebugTests(unittest.TestCase):
    def test_catalog_exposes_buggy_source_but_not_untested_capabilities(self):
        case = app_debug.catalog()
        self.assertEqual(case["case"], "duplicate-order-event")
        self.assertIn("def submit_order", case["buggySource"])
        self.assertIn("dynamodb.put_item", case["buggySource"])
        self.assertNotIn("ConditionExpression", case["buggySource"])
        self.assertEqual(case["availableVariants"], ["buggy", "fixed", "compare"])
        self.assertIn("does not execute arbitrary", case["instructions"])

    def test_reference_patch_matches_actual_two_source_files(self):
        left = app_debug.SOURCES["buggy"].read_text()
        right = app_debug.SOURCES["fixed"].read_text()
        correct = "".join(unified_diff(
            left.splitlines(keepends=True), right.splitlines(keepends=True),
            fromfile="a/order_service.py", tofile="b/order_service.py"))
        self.assertEqual(app_debug.PATCH.read_text(), correct)
        self.assertIn("ConditionalCheckFailedException", correct)
        self.assertIn("ConditionExpression", correct)

    def test_buggy_source_emits_duplicate_and_fixed_source_does_not(self):
        broken = app_debug._load_app("buggy")
        fixed = load_fixed()
        arguments = {
            "table": "synthetic-table", "bucket": "mcp-app-bucket",
            "queue_url": "http://localhost/queue",
            "order": {"id": "order-1", "sku": "local-widget", "quantity": 2},
        }
        ddb, s3, sqs = FakeDynamo(), FakeS3(), FakeSQS()
        first = broken.submit_order(ddb, s3, sqs, **arguments)
        second = broken.submit_order(ddb, s3, sqs, **arguments)
        self.assertTrue(first["accepted"] and second["accepted"])
        self.assertEqual(len(sqs.events), 2)
        self.assertEqual(len(s3.events), 2)
        ddb, s3, sqs = FakeDynamo(), FakeS3(), FakeSQS()
        first = fixed.submit_order(ddb, s3, sqs, **arguments)
        second = fixed.submit_order(ddb, s3, sqs, **arguments)
        self.assertTrue(first["accepted"])
        self.assertFalse(second["accepted"])
        self.assertEqual(second["status"], "duplicate")
        self.assertEqual(len(sqs.events), 1)
        self.assertEqual(len(s3.events), 1)
        self.assertEqual(ddb.calls[0]["ConditionExpression"], "attribute_not_exists(#pk)")
        self.assertEqual(ddb.calls[0]["ExpressionAttributeNames"], {"#pk": "id"})

    def test_fixed_source_does_not_hide_other_sdk_errors(self):
        fixed = load_fixed()
        ddb = FakeDynamo()
        ddb.error_code = "AccessDeniedException"
        with self.assertRaises(FakeClientError) as error:
            fixed.submit_order(
                ddb, FakeS3(), FakeSQS(),
                table="local", bucket="local", queue_url="http://localhost",
                order={"id": "order-1", "sku": "item"})
        self.assertEqual(error.exception.response["Error"]["Code"],
                         "AccessDeniedException")

    def test_untrusted_variant_rejected_before_execution(self):
        with patch.object(app_debug, "_run_variant",
                          side_effect=AssertionError("must not run")):
            for variant in ("../unsafe", "http://example.com", "", 99, None, {}):
                with self.subTest(variant=repr(variant)):
                    with self.assertRaisesRegex(aws.LocalError, "Unknown packaged"):
                        app_debug.run(variant)
        with self.assertRaisesRegex(aws.LocalError, "Invalid packaged"):
            app_debug._load_app("../unsafe")

    def test_compare_requires_real_failure_real_fix_and_cleanup(self):
        before = {
            "passed": False,
            "error": "A duplicate-order invariant or resource cleanup failed",
            "observed": {"acceptedSubmissions": 2, "queueEvents": 2,
                         "duplicateSuppressed": False},
            "cleanup": [{"name": "delete", "passed": True}],
            "assertions": [{"name": "one event", "passed": False}],
        }
        after = {
            "passed": True,
            "observed": {"acceptedSubmissions": 1, "queueEvents": 1,
                         "duplicateSuppressed": True},
            "cleanup": [{"name": "delete", "passed": True}],
        }
        with patch.object(app_debug, "_run_variant", side_effect=[before, after]):
            report = app_debug.run("compare")
        self.assertTrue(report["passed"], report)
        self.assertIn("--- a/order_service.py", report["referencePatch"])
        self.assertEqual(len(report["referencePatchSha256"]), 64)
        broken_cleanup = dict(before, cleanup=[{"name": "delete", "passed": False}])
        with patch.object(app_debug, "_run_variant", side_effect=[broken_cleanup, after]):
            report = app_debug.run("compare")
        self.assertFalse(report["passed"])
        self.assertFalse(report["bugReproduced"])

    def test_application_execution_fails_closed_outside_docker(self):
        with patch.dict("os.environ", {"AWS_EMULATOR_MCP_ISOLATED_LAB": "0"}):
            with self.assertRaisesRegex(
                    aws.LocalError, "requires isolated Docker lab"):
                app_debug._run_variant("buggy")

    def test_app_tools_are_docker_only_not_native_host(self):
        names = {tool["name"] for tool in aws.TOOLS}
        self.assertNotIn("app_debug_run", names)
        self.assertNotIn("app_debug_catalog", names)


if __name__ == "__main__":
    unittest.main()
