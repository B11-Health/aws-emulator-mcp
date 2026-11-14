"""A minimal order-intake application with an intentional retry bug.

This is application code: SDK clients and resource names are injected, not
wired to AWS Emulator or to any production account.
"""
import json


def submit_order(dynamodb, s3, sqs, *, table, bucket, queue_url, order):
    """Store an order, write its receipt, and queue a fulfillment event."""
    body = json.dumps(order, sort_keys=True, separators=(",", ":"))
    dynamodb.put_item(
        TableName=table,
        Item={
            "id": {"S": order["id"]},
            "sku": {"S": order["sku"]},
            "status": {"S": "queued"},
        },
    )
    s3.put_object(
        Bucket=bucket,
        Key="receipts/" + order["id"] + ".json",
        Body=body.encode("utf-8"),
        ContentType="application/json",
    )
    sqs.send_message(QueueUrl=queue_url, MessageBody=body)
    return {"accepted": True, "status": "queued"}
