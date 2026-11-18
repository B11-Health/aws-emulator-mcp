"""Deliberately broken: a duplicate submission creates two SQS events."""


def handle(clients, inputs):
    # A real developer could select their own module with this interface.
    clients["dynamodb"].put_item(
        TableName=inputs["table"],
        Item={"id": {"S": inputs["id"]}, "state": {"S": "queued"}},
    )
    clients["sqs"].send_message(
        QueueUrl=inputs["queueUrl"], MessageBody=inputs["body"])
