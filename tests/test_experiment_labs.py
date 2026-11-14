"""Experiment evidence contracts without any live service or AWS calls."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from aws_emulator_mcp import labs
from aws_emulator_mcp import server as aws


class ExperimentTests(unittest.TestCase):
    def test_catalog_has_bounded_unique_scenarios_and_caveats(self):
        data=labs.catalog()
        self.assertEqual(data["schemaVersion"], 1)
        self.assertEqual([item["id"] for item in data["experiments"]], list(labs.SUPPORTED))
        for item in data["experiments"]:
            self.assertTrue(item["services"])
            self.assertTrue(item["caveat"])
        self.assertIn("experiments.json", str(labs.CATALOG_FILE))

    def test_unknown_experiment_rejected_before_any_emulator_call(self):
        with patch.object(aws, "health", side_effect=AssertionError("should not connect")):
            for name in ("../secrets", "cmd", "s3", "", None, {"x": 1}):
                with self.subTest(name=str(name)), self.assertRaisesRegex(aws.LocalError, "Unknown AWS experiment"):
                    labs.run(name)

    def test_s3_expected_404_then_repair_and_scoped_cleanup(self):
        calls=[]
        def get_object(bucket, key):
            if not any(x == "put" for x in calls):
                raise aws.LocalError("HTTP 404 missing test object")
            return {"text": "synthetic-receipt-" + bucket.rsplit("-", 1)[-1]}
        def put_object(bucket, key, text):
            calls.append("put")
            return {"status": 200}
        with patch.object(aws, "health", return_value={"running": True}), \
             patch.object(aws, "identity", return_value={"Account": "000000000000"}), \
             patch.object(aws, "s3_create_bucket", return_value={"status": 200}) as create, \
             patch.object(aws, "s3_get_object", side_effect=get_object), \
             patch.object(aws, "s3_put_object", side_effect=put_object), \
             patch.object(aws, "s3_list_objects", return_value={"keys": ["experiments/receipt.txt"]}), \
             patch.object(aws, "s3_delete_object", return_value={"deleted": True}) as delete_object, \
             patch.object(aws, "s3_delete_bucket", return_value={"deleted": True}) as delete_bucket, \
             patch.object(aws, "s3_list_buckets", return_value={"buckets": []}):
            result=labs.run("s3-recovery")
        self.assertTrue(result["passed"], result)
        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["verifiedAccount"], "000000000000")
        self.assertEqual(len(result["expectedFailures"]), 1)
        self.assertEqual(result["expectedFailures"][0]["observed"], "HTTP 404")
        self.assertEqual(len(result["cleanup"]), 3)
        self.assertTrue(all(x["passed"] for x in result["cleanup"]))
        self.assertTrue(create.call_args.args[0].startswith("mcp-lab-objects-"))
        self.assertEqual(delete_object.call_args.args[1], "experiments/receipt.txt")
        self.assertEqual(delete_bucket.call_args.args[0], create.call_args.args[0])

    def test_failed_repair_still_attempts_scoped_cleanup_and_fails_report(self):
        with patch.object(aws, "health", return_value={"running": True}), \
             patch.object(aws, "identity", return_value={"Account": "000000000000"}), \
             patch.object(aws, "s3_create_bucket"), \
             patch.object(aws, "s3_get_object", side_effect=aws.LocalError("HTTP 404")), \
             patch.object(aws, "s3_put_object", side_effect=aws.LocalError("synthetic repair failed")), \
             patch.object(aws, "s3_delete_object") as delete_object, \
             patch.object(aws, "s3_delete_bucket") as delete_bucket, \
             patch.object(aws, "s3_list_buckets", return_value={"buckets": []}):
            result=labs.run("s3-recovery")
        self.assertFalse(result["passed"])
        self.assertIn("synthetic repair failed", result["error"])
        self.assertTrue(any(not x["passed"] for x in result["steps"]))
        delete_object.assert_called_once()
        delete_bucket.assert_called_once()

    def test_cleanup_failure_never_returns_success(self):
        def get_object(bucket, key):
            if not had_put[0]:raise aws.LocalError("HTTP 404")
            return {"text": "synthetic-receipt-" + bucket.rsplit("-", 1)[-1]}
        had_put=[False]
        with patch.object(aws, "health", return_value={"running": True}), \
             patch.object(aws, "identity", return_value={"Account": "000000000000"}), \
             patch.object(aws, "s3_create_bucket"), \
             patch.object(aws, "s3_get_object", side_effect=get_object), \
             patch.object(aws, "s3_put_object", side_effect=lambda *args: had_put.__setitem__(0,True)), \
             patch.object(aws, "s3_list_objects", return_value={"keys": ["experiments/receipt.txt"]}), \
             patch.object(aws, "s3_delete_object", side_effect=aws.LocalError("forced cleanup failure")), \
             patch.object(aws, "s3_delete_bucket"), \
             patch.object(aws, "s3_list_buckets", return_value={"buckets": []}):
            result=labs.run("s3-recovery")
        self.assertFalse(result["passed"])
        self.assertTrue(any(not x["passed"] for x in result["cleanup"]))

    def test_dynamodb_overwrite_proves_value_change_and_removal(self):
        statuses=iter(["draft", "approved"])
        with patch.object(aws, "health", return_value={"running": True}), \
             patch.object(aws, "identity", return_value={"Account": "000000000000"}), \
             patch.object(aws, "dynamodb_create_table") as create, \
             patch.object(aws, "dynamodb_put_item") as put, \
             patch.object(aws, "dynamodb_get_item", side_effect=lambda *a: {"Item": {"message": {"S": next(statuses)}}}), \
             patch.object(aws, "dynamodb_delete_table") as delete, \
             patch.object(aws, "dynamodb_list_tables", return_value={"TableNames": []}):
            result=labs.run("dynamodb-overwrite")
        self.assertTrue(result["passed"], result)
        self.assertEqual(len(result["steps"]), 7)
        self.assertEqual(len(result["cleanup"]), 2)
        self.assertFalse(result["expectedFailures"])
        self.assertEqual([x.args[2] for x in put.call_args_list], ["draft", "approved"])
        self.assertEqual(delete.call_args.args[0], create.call_args.args[0])

    def test_mcp_catalog_and_rejected_untrusted_lab_run(self):
        message={"jsonrpc": "2.0", "id": 10, "method": "tools/call",
                 "params": {"name": "lab_catalog", "arguments": {}}}
        result=aws.handle(message)["result"]
        self.assertFalse(result["isError"])
        self.assertEqual(len(json.loads(result["content"][0]["text"])["experiments"]),8)
        message["params"]={"name":"lab_run", "arguments":{"experiment":"../bad"}}
        result=aws.handle(message)["result"]
        self.assertTrue(result["isError"])
        self.assertIn("Unknown AWS experiment",result["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
