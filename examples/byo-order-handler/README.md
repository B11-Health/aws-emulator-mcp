# Developer-supplied Python order handler — bounded pilot

Use a local Python `submit_order` to exercise real emulated DynamoDB, S3 and
SQS operations against a synthetic tenant, customer, totals and line items.

```sh
aws-emulator-mcp app-verify examples/byo-order-handler/fixed.py --json
aws-emulator-mcp app-verify examples/byo-order-handler/buggy.py --json
```

The first must pass with one accepted order and one SQS event. The second
must fail with two duplicate events. Both verify 7/7 scoped cleanup checks.

[Safety boundary, input schema and actual signed-emulator evidence](../../docs/BYO_HANDLER.md).
