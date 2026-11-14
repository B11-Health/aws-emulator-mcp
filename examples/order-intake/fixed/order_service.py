"""A minimal order-intake application with a retry guard.

The fix prevents a *successfully completed* duplicate request from
publishing another message. It is not a transactional outbox: crashes
between DynamoDB, S3 and SQS still require production-grade recovery.
"""
import json

from botocore.exceptions import ClientError


def submit_order(dynamodb, s3, sqs, *, table, bucket, queue_url, order):
    """Store an order once, then write its receipt and queue fulfillment."""
    body = json.dumps(order, sort_keys=True, separators=(",", ":"))
    try:
        dynamodb.put_item(
            TableName=table,
            Item={
                "id": {"S": order["id"]},
                "sku": {"S": order["sku"]},
                "status": {"S": "queued"},
            },
            ConditionExpression="attribute_not_exists(#pk)",
            ExpressionAttributeNames={"#pk": "id"},
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        return {"accepted": False, "status": "duplicate"}
    s3.put_object(
        Bucket=bucket,
        Key="receipts/" + order["id"] + ".json",
        Body=body.encode("utf-8"),
        ContentType="application/json",
    )
    sqs.send_message(QueueUrl=queue_url, MessageBody=body)
    return {"accepted": True, "status": "queued"}
