"""Conditional DynamoDB write prevents a second queue submission on retry."""
from botocore.exceptions import ClientError


def handle(clients, inputs):
    try:
        clients["dynamodb"].put_item(
            TableName=inputs["table"],
            Item={"id": {"S": inputs["id"]}, "state": {"S": "queued"}},
            ConditionExpression="attribute_not_exists(id)",
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return
        raise
    clients["sqs"].send_message(
        QueueUrl=inputs["queueUrl"], MessageBody=inputs["body"])
