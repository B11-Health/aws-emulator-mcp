"""Broken app: silently discards a one-shot timeout before sending to SQS."""
from botocore.exceptions import ReadTimeoutError


def handle(clients, inputs):
    try:
        clients["sqs"].send_message(
            QueueUrl=inputs["queueUrl"], MessageBody=inputs["body"])
    except ReadTimeoutError:
        # Bug: treating an undelivered write as delivered loses the event.
        return
