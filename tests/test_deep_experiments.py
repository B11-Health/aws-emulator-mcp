"""Deterministic safety/negative tests for cross-service AWS experiments.

These mocks test orchestration and fail-closed reports; CI's Docker smoke test
independently verifies the actual upstream signed emulator.
"""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from aws_emulator_mcp import labs, server as aws


class BaseLabCase(unittest.TestCase):
    def run_lab(self, name, fake_sdk):
        with patch.object(aws, "health", return_value={"running": True}), \
             patch.object(aws, "identity", return_value={"Account": "000000000000"}), \
             patch.object(labs, "_sdk", side_effect=fake_sdk):
            return labs.run(name)


class SnsSqsDeliveryTests(BaseLabCase):
    def fake(self, delivered=True):
        state = {"topic": None, "queue": None, "subscription": None,
                 "policy": None, "published": None, "acked": False, "calls": []}
        def sdk(svc, operation, payload):
            state["calls"].append((svc, operation, payload))
            if (svc, operation) == ("sns", "CreateTopic"):
                state["topic"] = "arn:aws:sns:us-east-1:000000000000:" + payload["Name"]
                return {"TopicArn": state["topic"]}
            if (svc, operation) == ("sqs", "CreateQueue"):
                state["queue"] = "http://127.0.0.1:9297/000000000000/" + payload["QueueName"]
                return {"QueueUrl": state["queue"]}
            if (svc, operation) == ("sqs", "GetQueueAttributes"):
                return {"Attributes": {"QueueArn": "arn:aws:sqs:us-east-1:000000000000:queue"}}
            if (svc, operation) == ("sqs", "SetQueueAttributes"):
                state["policy"] = json.loads(payload["Attributes"]["Policy"])
                return {}
            if (svc, operation) == ("sns", "Subscribe"):
                self.assertEqual(state["policy"]["Statement"][0]["Condition"]["ArnEquals"]["aws:SourceArn"],
                                 state["topic"])
                state["subscription"] = "arn:aws:sns:us-east-1:000000000000:subscription"
                return {"SubscriptionArn": state["subscription"]}
            if (svc, operation) == ("sns", "Publish"):
                state["published"] = payload["Message"]
                return {"MessageId": "synthetic-message-id"}
            if (svc, operation) == ("sqs", "ReceiveMessage"):
                return {"Messages": [{"Body": "event=" + state["published"],
                                      "ReceiptHandle": "synthetic-receipt"}]} if delivered else {}
            if (svc, operation) == ("sqs", "DeleteMessage"):
                self.assertEqual(payload["ReceiptHandle"], "synthetic-receipt")
                state["acked"] = True
                return {}
            if (svc, operation) == ("sns", "Unsubscribe"):
                state["subscription"] = None
                return {}
            if (svc, operation) == ("sqs", "DeleteQueue"):
                state["queue"] = None
                return {}
            if (svc, operation) == ("sns", "DeleteTopic"):
                state["topic"] = None
                return {}
            if (svc, operation) == ("sns", "ListTopics"):
                return {"Topics": []}
            raise AssertionError("Unexpected SDK action: " + svc + "." + operation)
        return state, sdk

    def test_policy_is_required_before_delivery_and_message_is_acknowledged(self):
        state, sdk = self.fake()
        result = self.run_lab("sns-sqs-delivery", sdk)
        self.assertTrue(result["passed"], result)
        self.assertEqual(len(result["steps"]), 10)
        self.assertEqual(len(result["cleanup"]), 4)
        self.assertTrue(state["acked"])
        self.assertFalse(state["topic"])
        self.assertFalse(state["queue"])
        calls = [(service, name) for service, name, _ in state["calls"]]
        self.assertLess(calls.index(("sqs", "SetQueueAttributes")),
                        calls.index(("sns", "Subscribe")))
        self.assertLess(calls.index(("sns", "Publish")),
                        calls.index(("sqs", "ReceiveMessage")))

    def test_undelivered_message_fails_and_still_cleans_up(self):
        state, sdk = self.fake(delivered=False)
        with patch.object(labs.time, "sleep"):
            result = self.run_lab("sns-sqs-delivery", sdk)
        self.assertFalse(result["passed"])
        self.assertIn("not delivered", result["error"])
        self.assertFalse(state["acked"])
        self.assertTrue(all(x["passed"] for x in result["cleanup"]))
        self.assertEqual(len(result["cleanup"]), 4)


class Ec2LifecycleTests(BaseLabCase):
    def test_ec2_created_resources_are_deleted_in_dependency_order(self):
        state = {"vpc": False, "subnet": False, "sg": False, "deleted": []}
        def sdk(svc, operation, payload):
            self.assertEqual(svc, "ec2")
            if operation == "CreateVpc":
                state["vpc"] = True
                return {"Vpc": {"VpcId": "vpc-test"}}
            if operation == "DescribeVpcs":
                return {"Vpcs": [{"VpcId": "vpc-test"}]} if state["vpc"] else {"Vpcs": []}
            if operation == "CreateSubnet":
                self.assertTrue(state["vpc"])
                state["subnet"] = True
                return {"Subnet": {"SubnetId": "subnet-test"}}
            if operation == "DescribeSubnets":
                return {"Subnets": [{"SubnetId": "subnet-test"}]}
            if operation == "CreateSecurityGroup":
                state["sg"] = True
                return {"GroupId": "sg-test"}
            if operation == "DescribeSecurityGroups":
                return {"SecurityGroups": [{"GroupId": "sg-test"}]}
            if operation.startswith("Delete"):
                state["deleted"].append(operation)
                if operation == "DeleteSecurityGroup": state["sg"] = False
                if operation == "DeleteSubnet": state["subnet"] = False
                if operation == "DeleteVpc":
                    self.assertFalse(state["sg"] or state["subnet"])
                    state["vpc"] = False
                return {}
            raise AssertionError(operation)
        result = self.run_lab("ec2-vpc-lifecycle", sdk)
        self.assertTrue(result["passed"], result)
        self.assertEqual(state["deleted"], [
            "DeleteSecurityGroup", "DeleteSubnet", "DeleteVpc"])
        self.assertEqual(len(result["cleanup"]), 4)


class AdditionalServiceTests(BaseLabCase):
    def test_eventbridge_reports_only_ingestion_not_routing(self):
        state = {"bus": None}
        def sdk(svc, operation, payload):
            self.assertEqual(svc, "events")
            if operation == "CreateEventBus":
                state["bus"] = payload["Name"]
                return {"EventBusArn": "arn:aws:events:us-east-1:000000000000:event-bus/" + state["bus"]}
            if operation == "ListEventBuses":
                return {"EventBuses": [{"Name": state["bus"]}]} if state["bus"] else {"EventBuses": []}
            if operation == "PutEvents":
                self.assertEqual(payload["Entries"][0]["EventBusName"], state["bus"])
                return {"FailedEntryCount": 0, "Entries": [{"EventId": "sample"}]}
            if operation == "DeleteEventBus":
                state["bus"] = None
                return {}
            raise AssertionError(operation)
        result = self.run_lab("eventbridge-bus", sdk)
        self.assertTrue(result["passed"], result)
        self.assertIn("no targets", result["limitations"].lower())

    def test_ssm_parameter_value_is_checked_then_removed(self):
        state = {}
        def sdk(svc, operation, payload):
            self.assertEqual(svc, "ssm")
            if operation == "PutParameter":
                state["name"] = payload["Name"]
                state["value"] = payload["Value"]
                self.assertEqual(payload["Type"], "String")
                return {"Version": 1}
            if operation == "GetParameter":
                return {"Parameter": {"Value": state["value"]}}
            if operation == "DeleteParameter":
                self.assertEqual(payload["Name"], state["name"])
                state["value"] = None
                return {}
            if operation == "GetParameters":
                return {"InvalidParameters": [state["name"]]}
            raise AssertionError(operation)
        result = self.run_lab("ssm-parameter", sdk)
        self.assertTrue(result["passed"], result)
        self.assertNotIn("synthetic-parameter-", json.dumps(result))

    def test_secret_value_never_enters_evidence_and_deletion_is_verified(self):
        state = {}
        def sdk(svc, operation, payload):
            self.assertEqual(svc, "secretsmanager")
            if operation == "CreateSecret":
                state["name"] = payload["Name"]
                state["value"] = payload["SecretString"]
                return {"ARN": "arn:aws:secretsmanager:us-east-1:000000000000:secret:sample"}
            if operation == "GetSecretValue":
                return {"SecretString": state["value"]}
            if operation == "DeleteSecret":
                self.assertTrue(payload["ForceDeleteWithoutRecovery"])
                state["value"] = None
                return {"DeletionDate": 1}
            if operation == "ListSecrets":
                self.assertNotIn("IncludePlannedDeletion", payload)
                return {"SecretList": []}
            raise AssertionError(operation)
        result = self.run_lab("secretsmanager-secret", sdk)
        self.assertTrue(result["passed"], result)
        self.assertNotIn("synthetic-secret-", json.dumps(result))
        self.assertIsNone(state["value"])


if __name__ == "__main__":
    unittest.main()
