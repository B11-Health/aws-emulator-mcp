"""Bounded SDK-boundary faults in agent-authored contracts, no emulator required."""
from pathlib import Path
import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from aws_emulator_mcp import contract_case as case, server as aws


class FakeSender:
    class Meta:
        method_to_api_mapping = {
            "send_message": "SendMessage",
            "create_queue": "CreateQueue",
        }
    meta = Meta()

    def __init__(self, *, real_error=False):
        self.calls = []
        self.real_error = real_error

    def send_message(self, **params):
        self.calls.append(dict(params))
        if self.real_error:
            class Failure(Exception):
                response = {"Error": {"Code": "RequestTimeout"}}
            raise Failure("sensitive-raw-request-content")
        return {"MessageId": "opaque-message-id", "MD5OfMessageBody": "fake-digest"}


class FaultContracts(unittest.TestCase):
    def _run(self, plan, fake):
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "1"}), \
                patch.object(aws, "doctor", return_value={
                    "ready": True, "emulator_version": "synthetic-test"}), \
                patch.object(aws, "identity", return_value={
                    "Account": "000000000000"}), \
                patch("aws_emulator_mcp.aws_sdk._client",
                      return_value=(None, None, fake, None, None)):
            return case.execute(plan)

    def _plan(self, mode):
        return {
            "schemaVersion": 1, "name": "synthetic-lost-ack",
            "steps": [
                {"id": "original", "service": "sqs", "operation": "SendMessage",
                 "parameters": {"QueueUrl": "local-queue", "MessageBody": "bounded"},
                 "fault": {"mode": mode},
                 "expect": {"errorCode": "RequestTimeout"}},
                {"id": "retry", "service": "sqs", "operation": "SendMessage",
                 "parameters": {"QueueUrl": "local-queue", "MessageBody": "bounded"},
                 "expect": {"assertions": [{"path": "MessageId", "exists": True}]}},
            ]
        }

    def test_guide_exposes_valid_examples_with_clear_limits(self):
        guide = case.guide()
        self.assertEqual(guide["maxSteps"], 16)
        self.assertEqual(guide["faultInjection"]["maxFaultsPerPlan"], 1)
        self.assertIn("not an emulator/network outage",
                      guide["faultInjection"]["meaning"])
        for key, item in case.FAULT_EXAMPLES.items():
            with self.subTest(key=key):
                self.assertIs(case.validate(item), item)
                published = Path(__file__).resolve().parents[1] / "examples/contracts" / (key + ".json")
                self.assertEqual(json.loads(published.read_text()), item)

    def test_before_call_is_not_forwarded_and_retry_is_real(self):
        fake = FakeSender()
        proof = self._run(self._plan("before-call"), fake)
        self.assertTrue(proof["passed"], proof)
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(proof["steps"][0]["observed"], "synthetic_sdk_timeout")
        self.assertEqual(proof["steps"][0]["fault"]["sentToEmulator"], False)
        self.assertEqual(proof["steps"][0]["errorCode"], "RequestTimeout")
        self.assertEqual(proof["steps"][1]["observed"], "success")
        self.assertEqual(proof["passedSteps"], 2)
        self.assertNotIn("bounded", str(proof))

    def test_after_success_is_forwarded_and_acknowledgement_suppressed(self):
        fake = FakeSender()
        proof = self._run(self._plan("after-success"), fake)
        self.assertTrue(proof["passed"], proof)
        self.assertEqual(len(fake.calls), 2)
        self.assertEqual(fake.calls[0], fake.calls[1])
        self.assertEqual(proof["steps"][0]["fault"]["sentToEmulator"], True)
        self.assertEqual(proof["steps"][1]["observed"], "success")
        self.assertNotIn("local-queue", str(proof))

    def test_real_emulator_error_cannot_masquerade_as_injected_fault(self):
        fake = FakeSender(real_error=True)
        proof = self._run(self._plan("after-success"), fake)
        self.assertFalse(proof["passed"])
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(proof["steps"][0]["observed"], "api_error")
        self.assertEqual(proof["steps"][0]["errorCode"], "RequestTimeout")
        self.assertNotIn("fault", proof["steps"][0])
        self.assertEqual(len(proof["steps"]), 1)
        self.assertNotIn("sensitive-raw-request-content", str(proof))

    def test_one_fault_only_and_exact_fixed_code(self):
        plan = self._plan("before-call")
        altered = [
            dict(plan, steps=[dict(plan["steps"][0], fault=None)]),
            dict(plan, steps=[dict(plan["steps"][0], fault={})]),
            dict(plan, steps=[dict(plan["steps"][0], fault={"mode": "after-delay"})]),
            dict(plan, steps=[dict(plan["steps"][0], fault={"mode": "before-call", "script": "rm"})]),
            dict(plan, steps=[dict(plan["steps"][0],
                                   expect={"errorCode": "AccessDeniedException"})]),
            dict(plan, steps=[dict(plan["steps"][0], expect={})]),
            dict(plan, steps=[dict(plan["steps"][0], operation="ListQueues")]),
            dict(plan, steps=[dict(plan["steps"][0], service="iam", operation="CreateUser")]),
            dict(plan, steps=plan["steps"] + [dict(plan["steps"][0], id="other")]),
        ]
        for invalid in altered:
            with self.subTest(value=str(invalid)[:95]):
                with self.assertRaises(aws.LocalError):
                    case.validate(invalid)
        self.assertIs(case.validate(plan), plan)

    def test_failed_step_is_not_a_source_for_refs_or_duplicate_ids(self):
        plan = self._plan("before-call")
        bad = dict(plan, steps=plan["steps"] + [
            {"id": "bad", "service": "sqs", "operation": "SendMessage",
             "parameters": {"QueueUrl": {"$ref": "original.MessageId"}}}
        ])
        with self.assertRaisesRegex(aws.LocalError, "previous successful"):
            case.validate(bad)
        duplicated = dict(plan, steps=[plan["steps"][0], dict(plan["steps"][0], fault=None)])
        with self.assertRaises(aws.LocalError):
            case.validate(duplicated)

    def test_fault_rejected_without_docker_or_emulator_identity(self):
        fake = FakeSender()
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "0"}):
            with self.assertRaisesRegex(aws.LocalError, "isolated Docker"):
                case.execute(self._plan("before-call"))
        self.assertEqual(fake.calls, [])

    def test_existing_example_has_no_injection(self):
        fake = FakeSender()
        plan = {"schemaVersion": 1, "name": "normal", "steps": [
            {"id": "send", "service": "sqs", "operation": "SendMessage",
             "parameters": {"MessageBody": "hello", "QueueUrl": "local"},
             "expect": {"assertions": [{"path": "MessageId", "exists": True}]}}
        ]}
        result = self._run(plan, fake)
        self.assertTrue(result["passed"], result)
        self.assertNotIn("fault", result["steps"][0])
        self.assertEqual(len(fake.calls), 1)


if __name__ == "__main__":
    unittest.main()
