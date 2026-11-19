"""Synthetic receipt upload with the deliberate legacy ASCII-loss defect.

Trusted, self-contained app fixture. Called only by an explicit local app-case
execution; read-only inspection must never import or execute this module.
"""


def handle(clients, inputs):
    # Dropping non-ASCII characters loses the accent and receipt emoji.
    clients["s3"].put_object(
        Bucket=inputs["bucket"],
        Key=inputs["key"],
        Body=inputs["receipt"].encode("ascii", "ignore"),
    )
