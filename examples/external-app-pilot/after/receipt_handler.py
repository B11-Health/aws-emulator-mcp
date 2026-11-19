"""Synthetic receipt upload fixed to preserve every UTF-8 byte.

Trusted, self-contained app fixture. Called only by an explicit local app-case
execution; read-only inspection must never import or execute this module.
"""


def handle(clients, inputs):
    clients["s3"].put_object(
        Bucket=inputs["bucket"],
        Key=inputs["key"],
        Body=inputs["receipt"].encode("utf-8"),
    )
