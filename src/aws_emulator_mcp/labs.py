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
SUPPORTED = ("order-recovery", "s3-recovery", "dynamodb-overwrite",
             "sns-sqs-delivery", "ec2-vpc-lifecycle", "eventbridge-bus",
             "ssm-parameter", "secretsmanager-secret")


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



def _sdk(service, operation, parameters):
    """Call only the signed loopback emulator using its isolated SDK bridge."""
    from aws_emulator_mcp import aws_sdk
    response = aws_sdk.invoke(service, operation, parameters)
    return response["result"]


def _sns_sqs_delivery():
    record = Evidence("sns-sqs-delivery")
    suffix = secrets.token_hex(5)
    topic = "mcp-lab-topic-" + suffix
    queue = "mcp-lab-queue-" + suffix
    marker = "mcp-lab-notification-" + suffix
    topic_arn = queue_url = queue_arn = subscription_arn = None
    error = None
    try:
        record.verified_identity()
        result = record.step("create isolated SNS topic",
                             lambda: _sdk("sns", "CreateTopic", {"Name": topic}),
                             lambda r: bool(r.get("TopicArn")))
        topic_arn = result["TopicArn"]
        result = record.step("create isolated SQS queue",
                             lambda: _sdk("sqs", "CreateQueue", {"QueueName": queue}),
                             lambda r: bool(r.get("QueueUrl")))
        queue_url = result["QueueUrl"]
        result = record.step("discover queue ARN",
                             lambda: _sdk("sqs", "GetQueueAttributes", {
                                 "QueueUrl": queue_url, "AttributeNames": ["QueueArn"]}),
                             lambda r: bool(r.get("Attributes", {}).get("QueueArn")))
        queue_arn = result["Attributes"]["QueueArn"]
        policy = {"Version": "2012-10-17", "Statement": [{
            "Sid": "AllowLocalSnsDelivery", "Effect": "Allow",
            "Principal": {"Service": "sns.amazonaws.com"},
            "Action": "sqs:SendMessage",
            "Resource": queue_arn,
            "Condition": {"ArnEquals": {"aws:SourceArn": topic_arn}}
        }]}
        record.step("authorize exactly this SNS topic to send SQS messages",
                    lambda: _sdk("sqs", "SetQueueAttributes", {
                        "QueueUrl": queue_url,
                        "Attributes": {"Policy": json.dumps(policy, separators=(",", ":"))}
                    }))
        result = record.step("subscribe queue to SNS topic",
                             lambda: _sdk("sns", "Subscribe", {
                                 "TopicArn": topic_arn,
                                 "Protocol": "sqs", "Endpoint": queue_arn}),
                             lambda r: bool(r.get("SubscriptionArn")) and
                                       r.get("SubscriptionArn") != "pending confirmation")
        subscription_arn = result["SubscriptionArn"]
        record.step("publish synthetic SNS event",
                    lambda: _sdk("sns", "Publish", {
                        "TopicArn": topic_arn, "Message": marker}),
                    lambda r: bool(r.get("MessageId")))

        def receive():
            for attempt in range(8):
                result = _sdk("sqs", "ReceiveMessage", {
                    "QueueUrl": queue_url, "MaxNumberOfMessages": 3,
                    "WaitTimeSeconds": 1})
                messages = result.get("Messages", [])
                for message in messages:
                    if marker in message.get("Body", "") and message.get("ReceiptHandle"):
                        return message
                time.sleep(0.3)
            raise aws.LocalError("SNS message was not delivered into its SQS subscription")

        message = record.step("prove subscribed SQS queue received published marker",
                              receive, lambda m: marker in m.get("Body", ""))
        record.step("acknowledge SQS message by receipt handle",
                    lambda: _sdk("sqs", "DeleteMessage", {
                        "QueueUrl": queue_url, "ReceiptHandle": message["ReceiptHandle"]}))
    except Exception as exc:
        error = _error(exc)
    finally:
        if subscription_arn:
            record.cleanup("unsubscribe experiment queue",
                           lambda: _sdk("sns", "Unsubscribe", {
                               "SubscriptionArn": subscription_arn}))
        if queue_url:
            record.cleanup("delete experiment SQS queue",
                           lambda: _sdk("sqs", "DeleteQueue", {"QueueUrl": queue_url}))
        if topic_arn:
            record.cleanup("delete experiment SNS topic",
                           lambda: _sdk("sns", "DeleteTopic", {"TopicArn": topic_arn}))
            record.cleanup("verify SNS topic no longer listed",
                           lambda: _checked(topic_arn not in [
                               t.get("TopicArn") for t in
                               _sdk("sns", "ListTopics", {}).get("Topics", [])],
                               "Experiment SNS topic still exists"))
    return record.finish(error)


def _ec2_vpc_lifecycle():
    record = Evidence("ec2-vpc-lifecycle")
    suffix = secrets.token_hex(5)
    vpc_id = subnet_id = sg_id = None
    error = None
    try:
        record.verified_identity()
        result = record.step("create isolated emulated EC2 VPC",
                             lambda: _sdk("ec2", "CreateVpc", {"CidrBlock": "10.53.0.0/16"}),
                             lambda r: bool(r.get("Vpc", {}).get("VpcId")))
        vpc_id = result["Vpc"]["VpcId"]
        record.step("describe VPC by generated ID",
                    lambda: _sdk("ec2", "DescribeVpcs", {"VpcIds": [vpc_id]}),
                    lambda r: any(x.get("VpcId") == vpc_id for x in r.get("Vpcs", [])))
        result = record.step("create subnet inside experiment VPC",
                             lambda: _sdk("ec2", "CreateSubnet", {
                                 "VpcId": vpc_id, "CidrBlock": "10.53.1.0/24"}),
                             lambda r: bool(r.get("Subnet", {}).get("SubnetId")))
        subnet_id = result["Subnet"]["SubnetId"]
        record.step("describe subnet by generated ID",
                    lambda: _sdk("ec2", "DescribeSubnets", {"SubnetIds": [subnet_id]}),
                    lambda r: any(x.get("SubnetId") == subnet_id for x in r.get("Subnets", [])))
        result = record.step("create security group in experiment VPC",
                             lambda: _sdk("ec2", "CreateSecurityGroup", {
                                 "VpcId": vpc_id, "GroupName": "mcp-lab-" + suffix,
                                 "Description": "Synthetic local emulator lab"}),
                             lambda r: bool(r.get("GroupId")))
        sg_id = result["GroupId"]
        record.step("describe security group by generated ID",
                    lambda: _sdk("ec2", "DescribeSecurityGroups", {"GroupIds": [sg_id]}),
                    lambda r: any(x.get("GroupId") == sg_id
                                  for x in r.get("SecurityGroups", [])))
    except Exception as exc:
        error = _error(exc)
    finally:
        if sg_id:
            record.cleanup("delete experiment security group",
                           lambda: _sdk("ec2", "DeleteSecurityGroup", {"GroupId": sg_id}))
        if subnet_id:
            record.cleanup("delete experiment subnet",
                           lambda: _sdk("ec2", "DeleteSubnet", {"SubnetId": subnet_id}))
        if vpc_id:
            record.cleanup("delete experiment VPC",
                           lambda: _sdk("ec2", "DeleteVpc", {"VpcId": vpc_id}))
            record.cleanup("verify VPC absent from inventory",
                           lambda: _checked(vpc_id not in [x.get("VpcId") for x in
                               _sdk("ec2", "DescribeVpcs", {}).get("Vpcs", [])],
                               "Experiment VPC still exists"))
    return record.finish(error)


def _eventbridge_bus():
    record = Evidence("eventbridge-bus")
    name = "mcp-lab-bus-" + secrets.token_hex(5)
    created = False
    error = None
    try:
        record.verified_identity()
        created = True
        record.step("create isolated EventBridge bus",
                    lambda: _sdk("events", "CreateEventBus", {"Name": name}),
                    lambda r: bool(r.get("EventBusArn")))
        record.step("verify EventBridge bus listed",
                    lambda: _sdk("events", "ListEventBuses", {}),
                    lambda r: any(x.get("Name") == name for x in r.get("EventBuses", [])))
        record.step("put synthetic event with no targets",
                    lambda: _sdk("events", "PutEvents", {"Entries": [{
                        "Source": "aws-emulator-mcp.lab",
                        "DetailType": "SyntheticEvent",
                        "Detail": json.dumps({"test": True}),
                        "EventBusName": name
                    }]}),
                    lambda r: r.get("FailedEntryCount") == 0 and
                              bool(r.get("Entries", [{}])[0].get("EventId")))
    except Exception as exc:
        error = _error(exc)
    finally:
        if created:
            record.cleanup("delete experiment event bus",
                           lambda: _sdk("events", "DeleteEventBus", {"Name": name}))
            record.cleanup("verify bus absent from inventory",
                           lambda: _checked(name not in [x.get("Name") for x in
                               _sdk("events", "ListEventBuses", {}).get("EventBuses", [])],
                               "Experiment event bus still exists"))
    return record.finish(error)


def _ssm_parameter():
    record = Evidence("ssm-parameter")
    name = "/mcp/lab/parameter-" + secrets.token_hex(5)
    secret_marker = "synthetic-parameter-" + secrets.token_hex(5)
    attempted = False
    error = None
    try:
        record.verified_identity()
        attempted = True
        record.step("put synthetic plaintext SSM parameter",
                    lambda: _sdk("ssm", "PutParameter", {
                        "Name": name, "Value": secret_marker, "Type": "String"}),
                    lambda r: isinstance(r.get("Version"), int))
        record.step("verify SSM parameter round-trip without returning value",
                    lambda: _sdk("ssm", "GetParameter", {"Name": name}),
                    lambda r: r.get("Parameter", {}).get("Value") == secret_marker)
    except Exception as exc:
        error = _error(exc)
    finally:
        if attempted:
            record.cleanup("delete experiment parameter",
                           lambda: _sdk("ssm", "DeleteParameter", {"Name": name}))
            record.cleanup("verify parameter absent",
                           lambda: _checked(name in _sdk("ssm", "GetParameters", {
                               "Names": [name]}).get("InvalidParameters", []),
                               "Experiment SSM parameter still exists"))
    return record.finish(error)


def _secretsmanager_secret():
    record = Evidence("secretsmanager-secret")
    name = "mcp-lab-secret-" + secrets.token_hex(5)
    synthetic_value = "synthetic-secret-" + secrets.token_hex(5)
    attempted = False
    error = None
    try:
        record.verified_identity()
        attempted = True
        record.step("create disposable synthetic Secrets Manager secret",
                    lambda: _sdk("secretsmanager", "CreateSecret", {
                        "Name": name, "SecretString": synthetic_value}),
                    lambda r: bool(r.get("ARN")))
        record.step("verify secret value locally without emitting it as evidence",
                    lambda: _sdk("secretsmanager", "GetSecretValue", {"SecretId": name}),
                    lambda r: r.get("SecretString") == synthetic_value)
    except Exception as exc:
        error = _error(exc)
    finally:
        if attempted:
            record.cleanup("delete synthetic secret immediately",
                           lambda: _sdk("secretsmanager", "DeleteSecret", {
                               "SecretId": name, "ForceDeleteWithoutRecovery": True}))
            record.cleanup("verify deleted secret is absent from active listing",
                           lambda: _checked(name not in [
                               x.get("Name") for x in _sdk("secretsmanager", "ListSecrets", {}).get("SecretList", [])],
                               "Synthetic secret still appears in active inventory"))
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
            "dynamodb-overwrite": _dynamodb_overwrite,
            "sns-sqs-delivery": _sns_sqs_delivery,
            "ec2-vpc-lifecycle": _ec2_vpc_lifecycle,
            "eventbridge-bus": _eventbridge_bus,
            "ssm-parameter": _ssm_parameter,
            "secretsmanager-secret": _secretsmanager_secret}[experiment]()


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
