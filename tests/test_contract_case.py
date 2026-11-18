"""Contracts validate before execution and never forward source or cloud endpoints."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from aws_emulator_mcp import contract_case as cases
from aws_emulator_mcp import server as aws


class FakeClient:
    class Meta:
        method_to_api_mapping = {
            "create_bucket": "CreateBucket",
            "get_bucket_location": "GetBucketLocation",
            "list_buckets": "ListBuckets",
            "bogus_operation": "BogusOperation",
        }

    meta = Meta()

    def __init__(self):
        self.created = None
        self.calls = []

    def create_bucket(self, Bucket):
        self.created = Bucket
        self.calls.append("create")
        return {"Location": Bucket}

    def get_bucket_location(self, Bucket):
        self.calls.append("get")
        return {"LocationConstraint": Bucket}

    def list_buckets(self):
        self.calls.append("list")
        return {"Buckets": [{"Name": self.created}]}

    def bogus_operation(self):
        class FakeAPIError(Exception):
            response = {"Error": {"Code": "NotImplemented"}}
        raise FakeAPIError("redacted-request-information")


class ContractTests(unittest.TestCase):
    def test_guide_has_replayable_example(self):
        guide = cases.guide()
        self.assertEqual(guide["maxSteps"], 16)
        self.assertEqual(cases.validate(guide["example"]), guide["example"])

    def test_valid_reference_and_assertions(self):
        plan = {"schemaVersion": 1, "name": "local", "steps": [
            {"id": "create", "service": "s3", "operation": "CreateBucket",
             "parameters": {"Bucket": {"$fixture": "bucket"}}},
            {"id": "get", "service": "s3", "operation": "GetBucketLocation",
             "parameters": {"Bucket": {"$ref": "create.Location"}},
             "expect": {"assertions": [
                 {"path": "LocationConstraint", "equals": {"$ref": "create.Location"}},
                 {"path": "LocationConstraint", "exists": True},
                 {"path": "missing", "exists": False}]}}
        ]}
        self.assertIs(cases.validate(plan), plan)

    def test_reject_unsafe_and_malformed_contracts(self):
        base = cases.EXAMPLE
        self.assertIs(cases.validate(base), base)
        bad_cases = [
            None, {}, {"schemaVersion": True, "name": "x", "steps": base["steps"]},
            {"schemaVersion": 1, "name": "x", "steps": []},
            dict(base, script="rm -rf ."),
            dict(base, steps=base["steps"] * 6),
            dict(base, steps=[dict(base["steps"][0], id="../inject")]),
            dict(base, steps=[dict(base["steps"][0], parameters={
                "Bucket": {"$ref": "later.QueueUrl"}})]),
            dict(base, steps=[dict(base["steps"][0], parameters={
                "Bucket": {"$fixture": "credentials"}})]),
            dict(base, steps=[dict(base["steps"][0], parameters={
                "Bucket": {"$shell": "cat /etc/passwd"}})]),
            dict(base, steps=[dict(base["steps"][0], parameters={
                "Bucket": "x" * 8193})]),
            dict(base, steps=[dict(base["steps"][0], expect={
                "errorCode": "NoSuchBucket", "assertions": [{"path": "Body", "exists": True}]})]),
            dict(base, steps=[dict(base["steps"][0], expect={
                "assertions": [{"path": "__class__[0]", "equals": "str"}]})]),
            dict(base, steps=[dict(base["steps"][0], expect={
                "assertions": [{"path": "Body", "exists": 1}]})]),
        ]
        for plan in bad_cases:
            with self.subTest(case=str(plan)[:100]):
                with self.assertRaises(aws.LocalError):
                    cases.validate(plan)

    def test_real_execution_logic_without_real_emulator(self):
        fake = FakeClient()
        plan = {"schemaVersion": 1, "name": "replay", "steps": [
            {"id": "create", "service": "s3", "operation": "CreateBucket",
             "parameters": {"Bucket": {"$fixture": "bucket"}}},
            {"id": "inspect", "service": "s3", "operation": "GetBucketLocation",
             "parameters": {"Bucket": {"$ref": "create.Location"}},
             "expect": {"assertions": [
                 {"path": "LocationConstraint", "equals": {"$ref": "create.Location"}},
                 {"path": "LocationConstraint", "exists": True}]}}
        ]}
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "1"}), \
             patch.object(aws, "doctor", return_value={"ready": True, "emulator_version": "test"}), \
             patch.object(aws, "identity", return_value={"Account": "000000000000"}), \
             patch("aws_emulator_mcp.aws_sdk._client", return_value=(None, None, fake, None, None)):
            proof = cases.execute(plan)
        self.assertTrue(proof["passed"], proof)
        self.assertEqual(proof["passedSteps"], 2)
        self.assertEqual(fake.calls, ["create", "get"])
        self.assertEqual(len(proof["planSha256"]), 64)
        self.assertNotIn(fake.created, str(proof))
        self.assertIn("responseSha256", proof["steps"][0])

    def test_expect_api_error_and_stop_on_mismatch(self):
        fake = FakeClient()
        good = {"schemaVersion": 1, "name": "error", "steps": [
            {"id": "oops", "service": "s3", "operation": "BogusOperation",
             "expect": {"errorCode": "NotImplemented"}}
        ]}
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "1"}), \
             patch.object(aws, "doctor", return_value={"ready": True, "emulator_version": "test"}), \
             patch.object(aws, "identity", return_value={"Account": "000000000000"}), \
             patch("aws_emulator_mcp.aws_sdk._client", return_value=(None, None, fake, None, None)):
            self.assertTrue(cases.execute(good)["passed"])
            bad = dict(good, steps=[dict(good["steps"][0], expect={
                "errorCode": "AccessDenied"})] + [
                {"id": "later", "service": "s3", "operation": "ListBuckets"}])
            report = cases.execute(bad)
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["steps"]), 1)
        self.assertEqual(report["steps"][0]["errorCode"], "NotImplemented")
        self.assertNotIn("redacted-request-information", str(report))

    def test_assertion_challenge_changes_one_expectation_not_aws_parameters(self):
        import copy
        import json
        original = json.loads((Path(__file__).resolve().parents[1] /
            "examples/contracts/sqs-consume.json").read_text())
        before = copy.deepcopy(original)
        mutation = cases._negative_control_plan(original)
        self.assertIsNotNone(mutation)
        mutated, index, assertion, step, path = mutation
        self.assertEqual((step, path), ("receive", "Messages.0.Body"))
        mutated["steps"][index]["expect"]["assertions"][assertion]["equals"] = (
            before["steps"][index]["expect"]["assertions"][assertion]["equals"])
        self.assertEqual(mutated, before)
        self.assertEqual(original, before)
        no_equals = {"schemaVersion": 1, "name": "no-equals", "steps": [
            {"id": "list", "service": "s3", "operation": "ListBuckets",
             "expect": {"assertions": [{"path": "Buckets", "exists": True}]}}
        ]}
        self.assertIsNone(cases._negative_control_plan(no_equals))

    def test_negative_control_catches_exact_assertion_and_avoids_app_code(self):
        fake = FakeClient()
        plan = {"schemaVersion": 1, "name": "local-mismatch", "steps": [
            {"id": "create", "service": "s3", "operation": "CreateBucket",
             "parameters": {"Bucket": {"$fixture": "bucket"}}},
            {"id": "inspect", "service": "s3", "operation": "GetBucketLocation",
             "parameters": {"Bucket": {"$ref": "create.Location"}},
             "expect": {"assertions": [{
                 "path": "LocationConstraint", "equals": {"$ref": "create.Location"}}]}}
        ]}
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "1"}), \
             patch.object(aws, "doctor", return_value={"ready": True, "emulator_version": "unit-test"}), \
             patch.object(aws, "identity", return_value={"Account": "000000000000"}), \
             patch("aws_emulator_mcp.aws_sdk._client", return_value=(None, None, fake, None, None)), \
             patch.object(cases, "run", side_effect=lambda selected: cases.execute(selected)) as local:
            result = cases.run_or_challenge(plan, negativeControl=True)
        self.assertTrue(result["passed"], result)
        self.assertEqual(result["assertionChallenge"]["status"], "detected")
        self.assertEqual(result["assertionChallenge"]["stepId"], "inspect")
        self.assertEqual(result["assertionChallenge"]["path"], "LocationConstraint")
        self.assertEqual(local.call_count, 2)
        self.assertFalse(result["applicationFixVerified"])
        self.assertFalse(result["productionAwsValidated"])
        self.assertEqual(fake.calls, ["create", "get", "create", "get"])

    def test_mcp_challenge_rejects_nonboolean_and_unrelated_failure(self):
        plan = {"schemaVersion": 1, "name": "probe", "steps": [
            {"id": "list", "service": "s3", "operation": "ListBuckets",
             "expect": {"assertions": [{"path": "Buckets.0.Name", "equals": "expected"}]}}
        ]}
        with patch.object(cases, "run") as worker:
            with self.assertRaisesRegex(aws.LocalError, "boolean"):
                cases.run_or_challenge(plan, negativeControl="yes")
            worker.assert_not_called()
        first = {"passed": True, "schemaVersion": 1,
                 "accountVerified": True, "emulatorVersion": "one",
                 "planSha256": __import__("hashlib").sha256(cases._json_bytes(plan)).hexdigest(),
                 "passedSteps": 1, "totalSteps": 1}
        control = {"passed": False, "schemaVersion": 1,
                   "accountVerified": True, "emulatorVersion": "different",
                   "planSha256": "not-verified", "passedSteps": 0, "totalSteps": 1}
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "1"}), \
             patch.object(cases, "run", side_effect=[first, control]) as worker:
            report = cases.challenge(plan)
        self.assertFalse(report["passed"])
        self.assertEqual(report["assertionChallenge"]["status"], "invalid_evidence")
        self.assertEqual(worker.call_count, 2)
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "0"}):
            with self.assertRaisesRegex(aws.LocalError, "isolated Docker"):
                cases.challenge(plan)

    def test_identity_or_runtime_rejected_before_sdk_calls(self):
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "0"}):
            with self.assertRaisesRegex(aws.LocalError, "isolated Docker"):
                cases.execute(cases.EXAMPLE)
            with self.assertRaisesRegex(aws.LocalError, "Docker-only"):
                cases.run(cases.EXAMPLE)
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "1"}), \
             patch.object(aws, "doctor", return_value={"ready": True, "emulator_version": "test"}), \
             patch.object(aws, "identity", return_value={"Account": "123456789012"}):
            with self.assertRaisesRegex(aws.LocalError, "identity"):
                cases.execute(cases.EXAMPLE)
            with self.assertRaisesRegex(aws.LocalError, "main Docker"):
                cases.run(cases.EXAMPLE)

    def test_published_example_matches_guide(self):
        import json
        sample = Path(__file__).resolve().parents[1] / "examples/contracts/s3-write-read.json"
        self.assertEqual(json.loads(sample.read_text()), cases.EXAMPLE)

    def test_docker_only_tools_not_exposed_in_native_mode(self):
        names = {row["name"] for row in aws.TOOLS}
        self.assertNotIn("contract_run", names)
        self.assertNotIn("contract_guide", names)


if __name__ == "__main__":
    unittest.main()
