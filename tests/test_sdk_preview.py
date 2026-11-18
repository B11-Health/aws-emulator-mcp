"""Exercise the optional Docker bridge with the same installed models as the product."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from aws_emulator_mcp import sdk_preview, server


@unittest.skipUnless(importlib.util.find_spec("botocore"), "requires the Docker lab's SDK models")
class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, AWS_EMULATOR_MCP_ISOLATED_LAB="1")
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_preview_never_creates_a_client_and_omitted_input_is_not_validated(self):
        with patch("botocore.session.Session.create_client", side_effect=AssertionError):
            result = sdk_preview.preview("dynamodb", "PutItem", limit=2)
            self.assertNotIn("validation", result)
            self.assertFalse(result["operationExecuted"])
            self.assertEqual(result["schema"]["nextOffset"], 2)
            members = result["schema"]["members"]
            self.assertEqual([x["name"] for x in members], ["Item", "TableName"])
            self.assertTrue(all(x["required"] for x in members))
            later = sdk_preview.preview("dynamodb", "PutItem", offset=2)["schema"]
            self.assertTrue(all(not x["required"] for x in later["members"]))
            self.assertIsNone(later["nextOffset"])
            check = sdk_preview.preview("dynamodb", "PutItem", parameters={})["validation"]
            self.assertEqual({r["path"] for r in check["issues"]}, {"TableName", "Item"})

    def test_explore_output_collections_and_enum_pages(self):
        # Recursive SDK shapes are browsed one level at a time.
        schema = sdk_preview.preview("dynamodb", "GetItem", direction="output",
                                     path="Item.*.L.*.M")["schema"]
        self.assertEqual(schema["itemType"], "structure")
        self.assertEqual(schema["itemPath"], "Item.*.L.*.M.*")
        enum = sdk_preview.preview("dynamodb", "PutItem", path="ReturnValues", limit=1)["schema"]
        self.assertEqual(len(enum["enum"]), 1)
        self.assertEqual(enum["nextOffset"], 1)
        with self.assertRaisesRegex(ValueError, "Unknown model path"):
            sdk_preview.preview("dynamodb", "PutItem", path="Item.secret")
        with self.assertRaisesRegex(ValueError, "Unknown operation"):
            sdk_preview.preview("dynamodb", "NoSuchOperation")
        with self.assertRaisesRegex(ValueError, "direction"):
            sdk_preview.preview("dynamodb", "GetItem", direction="both")

    def test_nested_error_is_actionable_and_redacts_values_map_keys_and_unknown_fields(self):
        bad = {"TableName": "private-table", "unknown-private": "private-payload",
               "Item": {"private.key[1]": {"L": [{"S": {"private-value": 42}}]}}}
        result = sdk_preview.preview("dynamodb", "PutItem", parameters=bad)
        self.assertNotIn("private", json.dumps(result))
        self.assertEqual(result["validation"]["issueCount"], 2)
        self.assertIn({"path": "Item.*.L.*.S", "reason": "invalid type", "modelType": "string"},
                      result["validation"]["issues"])
        good = {"TableName": "private-table", "Item": {"private.key[1]": {"S": "123"}}}
        self.assertTrue(sdk_preview.preview("dynamodb", "PutItem", parameters=good)["validation"]["valid"])

    def test_ambiguous_keys_and_many_errors_are_bounded(self):
        params = {"Item": {"alias": {"S": "ok"}, "alias.S": {"S": 8}}, "TableName": "example"}
        params.update({f"private-{n}": "private" for n in range(15)})
        check = sdk_preview.preview("dynamodb", "PutItem", parameters=params)["validation"]
        self.assertEqual(check["issueCount"], 16)
        self.assertEqual(len(check["issues"]), 12)
        ambiguous = {"Item": params["Item"], "TableName": params["TableName"]}
        issues = sdk_preview.preview("dynamodb", "PutItem", parameters=ambiguous)["validation"]["issues"]
        self.assertEqual(issues, [{"path": "Item.*", "reason": "invalid type"}])

    def test_no_input_shape_and_size_limits(self):
        for parameters, valid in (({}, True), ({"private": "value"}, False)):
            check = sdk_preview.preview("sts", "GetCallerIdentity", parameters=parameters)["validation"]
            self.assertIs(check["valid"], valid)
        with self.assertRaisesRegex(server.LocalError, "64 KiB"):
            sdk_preview.preview("s3", "PutObject", parameters={"Body": "x" * 65537})
