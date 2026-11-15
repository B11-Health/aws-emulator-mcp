"""Reviewed application behavior and fail-closed fault-lab controls."""
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from aws_emulator_mcp import failure_lab as lab, server as aws


class FakeClientError(Exception):
    def __init__(self, response, operation):
        self.response = response
        self.operation = operation
        super().__init__(response.get("Error", {}).get("Code", "Unexpected"))


class FakeDynamo:
    def __init__(self):
        self.rows = {}
        self.calls = []
        self.fail_code = None

    def put_item(self, **kwargs):
        self.calls.append(("PutItem", kwargs))
        if self.fail_code:
            raise FakeClientError({"Error": {"Code": self.fail_code}}, "PutItem")
        key = kwargs["Item"]["id"]["S"]
        if kwargs.get("ConditionExpression") and key in self.rows:
            raise FakeClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
        self.rows[key] = kwargs["Item"]
        return {}

    def get_item(self, **kwargs):
        self.calls.append(("GetItem", kwargs))
        return {"Item": self.rows.get(kwargs["Key"]["id"]["S"], {})}

    def update_item(self, **kwargs):
        self.calls.append(("UpdateItem", kwargs))
        key = kwargs["Key"]["id"]["S"]
        if key not in self.rows or self.rows[key]["status"]["S"] != "pending":
            raise FakeClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
        self.rows[key]["status"] = kwargs["ExpressionAttributeValues"][":queued"]
        return {}


class FakeS3:
    def __init__(self):
        self.stored = {}

    def put_object(self, **kwargs):
        self.stored[kwargs["Key"]] = kwargs["Body"]
        return {}


class FakeSQS:
    def __init__(self):
        self.sent = []

    def send_message(self, **kwargs):
        self.sent.append(kwargs)
        return {"MessageId": "message-" + str(len(self.sent))}


def with_fake_botocore():
    boto = types.ModuleType("botocore")
    boto.__path__ = []
    err = types.ModuleType("botocore.exceptions")
    err.ClientError = FakeClientError
    boto.exceptions = err
    return patch.dict(sys.modules, {"botocore": boto, "botocore.exceptions": err})


def submit_fixture(scenario):
    dynamo, s3, sqs = FakeDynamo(), FakeS3(), FakeSQS()
    app = lab._load_app(scenario)
    args = {"table": "test-table", "bucket": "mcp-test", "queue_url": "http://localhost/queue",
            "order": {"id": "id-1", "sku": "test-sku", "quantity": 2}}
    return dynamo, s3, sqs, app, args


class FailureLabTests(unittest.TestCase):
    def test_catalog_is_inspectable_and_bounded(self):
        evidence = lab.catalog()
        self.assertEqual(evidence["scenarios"], list(lab.SCENARIOS))
        self.assertEqual(len(evidence["sourceSha256"]["recoverable"]), 64)
        self.assertIn("def submit_order", evidence["fragileSource"])
        self.assertIn("def submit_order", evidence["recoverableSource"])
        self.assertIn("pending", evidence["recoverableSource"])
        self.assertIn("--- a/examples/order-intake/fixed/order_service.py", evidence["sourceDiff"])
        self.assertIn("+++ b/examples/reliability-lab/recovery/order_service.py", evidence["sourceDiff"])
        self.assertNotIn("AWS_ACCESS_KEY_ID", evidence["sourceDiff"])
        self.assertIn("before SQS", evidence["faults"]["before-send"])
        self.assertIn("local Python SDK wrapper", evidence["limitations"])
        self.assertIn("arbitrary code is not accepted", evidence["instructions"])

    def test_one_shot_presend_timeout_is_not_forwarded(self):
        with with_fake_botocore():
            sqs = FakeSQS()
            sender = lab.InjectSendFailure(sqs)
            with self.assertRaises(FakeClientError) as caught:
                sender.send_message(MessageBody="demo", QueueUrl="http://localhost/queue")
            self.assertEqual(caught.exception.response["Error"]["Code"], "RequestTimeout")
            self.assertEqual(len(sqs.sent), 0)
            sender.send_message(MessageBody="demo", QueueUrl="http://localhost/queue")
            self.assertEqual(len(sqs.sent), 1)
            self.assertEqual(sender.injected, 1)
            self.assertEqual(sender.forwarded, 1)

    def test_one_shot_lost_ack_has_real_delivery_before_timeout(self):
        with with_fake_botocore():
            sqs = FakeSQS()
            sender = lab.InjectSendFailure(sqs, forward_before_error=True)
            with self.assertRaises(FakeClientError):
                sender.send_message(MessageBody="one", QueueUrl="http://localhost/queue")
            self.assertEqual(len(sqs.sent), 1)
            sender.send_message(MessageBody="two", QueueUrl="http://localhost/queue")
            self.assertEqual(len(sqs.sent), 2)
            self.assertEqual(sender.injected, 1)
            self.assertEqual(sender.forwarded, 2)

    def test_existing_retry_guard_loses_event_after_presend_fault(self):
        with with_fake_botocore():
            dynamo, s3, sqs, app, kwargs = submit_fixture("fragile-before-send")
            broken_sqs = lab.InjectSendFailure(sqs)
            with self.assertRaises(FakeClientError):
                app.submit_order(dynamo, s3, broken_sqs, **kwargs)
            self.assertEqual(dynamo.rows["id-1"]["status"]["S"], "queued")
            retried = app.submit_order(dynamo, s3, broken_sqs, **kwargs)
            self.assertFalse(retried["accepted"])
            self.assertEqual(len(sqs.sent), 0)

    def test_pending_record_recovers_after_presend_fault(self):
        with with_fake_botocore():
            dynamo, s3, sqs, app, kwargs = submit_fixture("recover-before-send")
            broken_sqs = lab.InjectSendFailure(sqs)
            with self.assertRaises(FakeClientError):
                app.submit_order(dynamo, s3, broken_sqs, **kwargs)
            self.assertEqual(dynamo.rows["id-1"]["status"]["S"], "pending")
            retried = app.submit_order(dynamo, s3, broken_sqs, **kwargs)
            self.assertFalse(retried["accepted"])
            self.assertEqual(retried["status"], "queued")
            self.assertEqual(dynamo.rows["id-1"]["status"]["S"], "queued")
            self.assertEqual(len(sqs.sent), 1)
            event = json.loads(sqs.sent[0]["MessageBody"])
            self.assertEqual(event["eventId"], "fulfillment:id-1")
            self.assertEqual(event["order"], kwargs["order"])

    def test_lost_ack_retries_with_stable_event_id_for_deduplication(self):
        with with_fake_botocore():
            dynamo, s3, sqs, app, kwargs = submit_fixture("recover-lost-ack")
            broken_sqs = lab.InjectSendFailure(sqs, forward_before_error=True)
            with self.assertRaises(FakeClientError):
                app.submit_order(dynamo, s3, broken_sqs, **kwargs)
            retried = app.submit_order(dynamo, s3, broken_sqs, **kwargs)
            self.assertFalse(retried["accepted"])
            self.assertEqual(len(sqs.sent), 2)
            a, b = (json.loads(item["MessageBody"]) for item in sqs.sent)
            self.assertEqual(a, b)
            self.assertEqual(a["eventId"], "fulfillment:id-1")
            self.assertEqual(dynamo.rows["id-1"]["status"]["S"], "queued")

    def test_duplicate_order_with_different_payload_is_not_resumed(self):
        with with_fake_botocore():
            dynamo, s3, sqs, app, kwargs = submit_fixture("recover-before-send")
            sender = lab.InjectSendFailure(sqs)
            with self.assertRaises(FakeClientError):
                app.submit_order(dynamo, s3, sender, **kwargs)
            changed = dict(kwargs, order=dict(kwargs["order"], quantity=999))
            with self.assertRaisesRegex(ValueError, "Conflicting duplicate"):
                app.submit_order(dynamo, s3, sender, **changed)
            self.assertEqual(len(sqs.sent), 0)

    def test_other_dynamodb_errors_are_not_suppressed(self):
        with with_fake_botocore():
            ddb, s3, sqs, app, kwargs = submit_fixture("recover-before-send")
            ddb.fail_code = "AccessDeniedException"
            with self.assertRaises(FakeClientError) as caught:
                app.submit_order(ddb, s3, sqs, **kwargs)
            self.assertEqual(caught.exception.response["Error"]["Code"], "AccessDeniedException")
            self.assertEqual(len(sqs.sent), 0)

    def test_consumer_writes_dedupe_marker_before_ack(self):
        with with_fake_botocore():
            ddb = FakeDynamo()
            order = {"id": "a", "sku": "s", "quantity": 2}
            body = json.dumps({"eventId": "fulfillment:a", "order": order})
            queue_messages = [
                {"Body": body, "MessageId": "m1", "ReceiptHandle": "r1"},
                {"Body": body, "MessageId": "m2", "ReceiptHandle": "r2"},
            ]
            events = []
            def receive(_):
                if queue_messages:
                    return {"messages": [queue_messages.pop(0)]}
                return {"messages": []}
            def acknowledge(_, token):
                events.append(("ack", token))
                self.assertIn("processed#fulfillment:a", ddb.rows)
            original = ddb.put_item
            def track_marker(**params):
                events.append(("mark", params["Item"]["id"]["S"]))
                return original(**params)
            ddb.put_item = track_marker
            with patch.object(aws, "sqs_receive_messages", side_effect=receive), \
                 patch.object(aws, "sqs_delete_message", side_effect=acknowledge), \
                 patch.object(lab.time, "sleep"):
                result = lab._consume("queue", ddb, "table", order, dedupe=True)
            self.assertEqual(result["messages"], 2)
            self.assertEqual(result["effectMarkers"], 1)
            self.assertEqual(result["duplicatesIgnored"], 1)
            self.assertEqual([event[0] for event in events], ["mark", "ack", "mark", "ack"])

    def test_unknown_scenario_cannot_trigger_any_execution(self):
        with patch.object(lab, "_run_one", side_effect=AssertionError("not executed")):
            for invalid in ("", "../etc/passwd", "https://host", "install", None, 1, {}):
                with self.subTest(value=str(invalid)):
                    with self.assertRaisesRegex(aws.LocalError, "Unknown failure-lab"):
                        lab.run(invalid)
        with self.assertRaisesRegex(aws.LocalError, "Invalid reviewed"):
            lab._load_app("../unsafe")

    def test_no_execution_outside_isolated_docker(self):
        with patch.dict("os.environ", {"AWS_EMULATOR_MCP_ISOLATED_LAB": "0"}):
            with self.assertRaisesRegex(aws.LocalError, "isolated Docker"):
                lab._run_one("recover-before-send")

    def test_compare_requires_all_independent_runs_to_pass(self):
        fake = {"passed": True, "cleanup": [{"passed": True}]}
        with patch.object(lab, "_run_one", side_effect=[fake, fake, fake]):
            self.assertTrue(lab.run("compare")["passed"])
        with patch.object(lab, "_run_one", side_effect=[fake, dict(fake, passed=False), fake]):
            self.assertFalse(lab.run("compare")["passed"])

    def test_only_docker_server_exposes_failure_lab_tools(self):
        names = {tool["name"] for tool in aws.TOOLS}
        self.assertNotIn("failure_lab_run", names)
        self.assertNotIn("failure_lab_catalog", names)


if __name__ == "__main__":
    unittest.main()
