import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from aws_emulator_mcp import contract_case, project_plan


class ProjectPlanTests(unittest.TestCase):
    def test_drafts_only_for_overlapping_operations_and_preserve_guide(self):
        self.assertIn("example", contract_case.guide())
        report = contract_case.guide(["sqs.send_message", "sqs.get_queue_url", "s3.put_object",
                                      "dynamodb.put_item", "ec2.create_vpc", "lambda.invoke"])
        self.assertFalse(report["executed"])
        self.assertEqual(report["unmatchedMethods"], ["lambda.invoke"])
        self.assertEqual(len(report["drafts"]), 4)
        for draft in report["drafts"]:
            contract_case.validate(draft["plan"])
            self.assertFalse(set(draft["matchedMethods"]) & set(draft["additionalProbeMethods"]))
        sqs = next(draft["plan"] for draft in report["drafts"] if draft["service"] == "sqs")
        self.assertEqual(sqs["steps"][1]["operation"], "GetQueueUrl")
        self.assertEqual(sqs["steps"][1]["expect"]["assertions"][0]["equals"], {"$ref": "create.QueueUrl"})
        report = contract_case.guide(["sqs.unmodeled", "lambda.invoke", "lambda.invoke"])
        self.assertEqual(report["drafts"], [])
        self.assertEqual(report["unmatchedMethods"], ["lambda.invoke", "sqs.unmodeled"])
        for bad in ({"s3": 3}, ["s3.PutObject"], [None], ["sqs.send_message"] * 81):
            with self.assertRaises(ValueError):
                contract_case.guide(bad)

    def test_scopes_reassignment_and_direct_factory_calls(self):
        source = """import boto3 as aws
from boto3 import client as new_client
global_queue = aws.client("sqs")
def first():
    store = new_client(service_name="s3")
    store.put_object(Body=b"private", **kwargs)
    aws.client("ssm").get_parameter()
    global_queue.send_message()
def second(global_queue):
    global_queue.delete_queue()
    store = new_client("dynamodb")
    store.put_item()
def third():
    store = new_client("s3")
    store = unknown()
    store.delete_bucket()
def other(aws):
    aws.client("s3").list_buckets()
"""
        calls = project_plan._source_calls(source)
        self.assertEqual([c["method"] for c in calls],
                         ["s3.put_object", "ssm.get_parameter", "sqs.send_message", "dynamodb.put_item"])
        self.assertTrue(calls[0]["hasUnresolvedArguments"])
        self.assertEqual(calls[0]["keywordNames"], ["Body"])

    def test_explicit_boto3_sessions_are_detected_without_inference(self):
        source = """import boto3 as sdk
from boto3 import Session as AwsSession
from boto3.session import Session as SessionFromModule
session = sdk.Session(region_name='us-east-1')
session.client('s3').put_object()
a = AwsSession()
a.client('sqs').send_message()
SessionFromModule().client('dynamodb').get_item()
sdk.Session().client('ssm').get_parameter()
external = get_external_session()
external.client('s3').delete_bucket()
def f(session):
    session.client('s3').list_buckets()
def g():
    a = AwsSession()
    a = get_external_session()
    a.client('s3').delete_bucket()
"""
        calls = project_plan._source_calls(source)
        self.assertEqual([call["method"] for call in calls],
                         ["s3.put_object", "sqs.send_message", "dynamodb.get_item", "ssm.get_parameter"])

    def test_checkout_inventory_respects_tracking_skips_and_does_not_execute_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "handler.py").write_text(
                'import boto3\nraise RuntimeError("private payload")\nq = boto3.client("sqs")\n'
                'q.send_message(QueueUrl="private queue", MessageBody="private body", DelaySeconds=5)\n')
            (root / "broken.py").write_text('def broken(:\n')
            (root / "untracked.py").write_text('import boto3\nboto3.client("s3").put_object()')
            subprocess.run(["git", "init", "-q", tmp], check=True)
            subprocess.run(["git", "-C", tmp, "add", "--", "handler.py", "broken.py"], check=True)
            report = project_plan.inspect_path(root)
            self.assertEqual(len(report["analyzedFiles"]), 1)
            self.assertEqual(report["skippedFiles"][0]["file"], "broken.py")
            self.assertEqual(report["calls"][0]["line"], 4)
            self.assertEqual(report["clientMethods"], ["sqs.send_message"])
            self.assertEqual(report["drafts"][0]["argumentGaps"][0]["unexercisedKeywords"], ["DelaySeconds"])
            self.assertNotIn("private", json.dumps(report))
            if os.name != "nt":
                (root / "link.py").symlink_to(root / "handler.py")
                subprocess.run(["git", "-C", tmp, "add", "--", "link.py"], check=True)
                self.assertIn("link.py", [s["file"] for s in project_plan.inspect_path(root)["skippedFiles"]])

    def test_cli_exports_reviewable_contract_and_no_file_for_unmatched_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp, "source file.py")
            source.write_text('import boto3\nboto3.client("sqs").send_message()\n')
            cli = ["node", str(ROOT / "bin/aws-emulator-mcp.mjs"), "project-plan", str(source)]
            good = subprocess.run([*cli, "--contract", "sqs"], capture_output=True, text=True, check=True)
            contract_case.validate(json.loads(good.stdout))
            bad = subprocess.run([*cli, "--contract", "s3"], capture_output=True, text=True)
            self.assertNotEqual(bad.returncode, 0)
            self.assertEqual(bad.stdout, "")
