"""Trusted local example: S3 upload; independent SDK read in reviewed case."""


def handle(clients, inputs):
    clients['s3'].put_object(
        Bucket=inputs['bucket'],
        Key=inputs['key'],
        Body=inputs['data'],
    )
