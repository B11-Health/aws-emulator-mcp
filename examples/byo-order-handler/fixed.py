"""Synthetic user-supplied app with a narrow conditional-write retry fix.

Does NOT promise a transactional outbox or protection against partial
failures/crashes after the database write.
"""
import json

from botocore.exceptions import ClientError


def submit_order(dynamodb, s3, sqs, *, table, bucket, queue_url, order):
    body = json.dumps(order, sort_keys=True, separators=(",", ":"))
    try:
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
            ConditionExpression="attribute_not_exists(#pk)",
            ExpressionAttributeNames={"#pk": "id"},
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        return {"accepted": False, "status": "duplicate"}

    s3.put_object(
        Bucket=bucket, Key="receipts/" + order["id"] + ".json",
        Body=body.encode("utf-8"), ContentType="application/json",
    )
    sqs.send_message(QueueUrl=queue_url, MessageBody=body)
    return {"accepted": True, "status": "queued"}
