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

## Compare the two implementations (source checkout only)

On a checkout containing the unreleased comparison feature:

```bash
node bin/aws-emulator-mcp.mjs app-compare \
  examples/byo-order-handler/buggy.py \
  examples/byo-order-handler/fixed.py --markdown
```

Each trusted local handler runs in its own isolated Docker lab. The result
is redacted, with source hashes and before/after counters. See
[the security and scope guide](../../docs/BYO_HANDLER.md).
