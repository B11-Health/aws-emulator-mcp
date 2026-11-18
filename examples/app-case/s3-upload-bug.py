"""Deliberately broken: appends an extra byte before uploading an S3 object."""


def handle(clients, inputs):
    clients['s3'].put_object(
        Bucket=inputs['bucket'],
        Key=inputs['key'],
        Body=inputs['data'] + '!',
    )
