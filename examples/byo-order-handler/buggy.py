"""Synthetic user-supplied app. Intentional duplicate-order bug.

Same interface as a Python order handler a developer could write; run only in
a one-shot local Docker container, not by the remote MCP server.
"""
import json


def submit_order(dynamodb, s3, sqs, *, table, bucket, queue_url, order):
    body = json.dumps(order, sort_keys=True, separators=(",", ":"))
    dynamodb.put_item(
        TableName=table,
        Item={
            "id": {"S": order["id"]},
            "sku": {"S": order["sku"]},
            "status": {"S": "queued"},
            "tenantId": {"S": order["tenantId"]},
            "customerId": {"S": order["customerId"]},
            "currency": {"S": order["currency"]},
            "totalCents": {"N": str(order["totalCents"])},
            "lineCount": {"N": str(len(order["lineItems"]))},
        },
    )
    s3.put_object(
        Bucket=bucket, Key="receipts/" + order["id"] + ".json",
        Body=body.encode("utf-8"), ContentType="application/json",
    )
    sqs.send_message(QueueUrl=queue_url, MessageBody=body)
    return {"accepted": True, "status": "queued"}
