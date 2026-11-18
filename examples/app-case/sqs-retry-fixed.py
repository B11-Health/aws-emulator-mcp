"""App recovery branch: retry once after a pre-send SDK-boundary timeout."""
from botocore.exceptions import ReadTimeoutError


def handle(clients, inputs):
    for attempt in range(2):
        try:
            clients["sqs"].send_message(
                QueueUrl=inputs["queueUrl"], MessageBody=inputs["body"])
            return
        except ReadTimeoutError:
            if attempt == 1:
                raise
