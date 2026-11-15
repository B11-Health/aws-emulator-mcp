"""Recoverable order submission, deliberately limited to an at-least-once outbox.

The DynamoDB 'pending' marker records an unfinished publish. On retry a
caller may safely resume; when a send's acknowledgement is lost, duplicates
remain possible. Consumers must de-duplicate by the stable eventId.
"""
from __future__ import annotations

import json
from botocore.exceptions import ClientError


def submit_order(dynamodb, s3, sqs, *, table, bucket, queue_url, order):
    """Persist pending work; publish; mark queued. Caller retries failures."""
    body = json.dumps(order, sort_keys=True, separators=(",", ":"))
    item = {
        "id": {"S": order["id"]},
        "sku": {"S": order["sku"]},
        "quantity": {"N": str(order["quantity"])},
        "status": {"S": "pending"},
        "receipt": {"S": body},
    }
    created = False
    try:
        dynamodb.put_item(
            TableName=table, Item=item,
            ConditionExpression="attribute_not_exists(#pk)",
            ExpressionAttributeNames={"#pk": "id"},
        )
        created = True
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        row = dynamodb.get_item(
            TableName=table, Key={"id": {"S": order["id"]}},
            ConsistentRead=True,
        ).get("Item", {})
        if (row.get("receipt", {}).get("S") != body
                or row.get("sku", {}).get("S") != order["sku"]):
            raise ValueError("Conflicting duplicate logical order")
        if row.get("status", {}).get("S") == "queued":
            return {"accepted": False, "status": "already_queued"}
        if row.get("status", {}).get("S") != "pending":
            raise ValueError("Unexpected stored order state")

    # Rewriting the same deterministic receipt is safe. Publishing the
    # same event may still happen twice after the broker accepted a send.
    s3.put_object(
        Bucket=bucket, Key="receipts/" + order["id"] + ".json",
        Body=body.encode("utf-8"), ContentType="application/json",
    )
    event = {"eventId": "fulfillment:" + order["id"], "order": order}
    sqs.send_message(QueueUrl=queue_url, MessageBody=json.dumps(
        event, sort_keys=True, separators=(",", ":")))
    dynamodb.update_item(
        TableName=table, Key={"id": {"S": order["id"]}},
        UpdateExpression="SET #status = :queued",
        ConditionExpression="#status = :pending",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":queued": {"S": "queued"}, ":pending": {"S": "pending"},
        },
    )
    return {"accepted": created, "status": "queued"}
