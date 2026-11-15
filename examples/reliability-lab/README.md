# Order delivery under controlled AWS SDK failures

This is a bounded Python app, tested against the official local AWS Emulator.

- **Fragile:** existing `examples/order-intake/fixed/order_service.py` uses a
  DynamoDB conditional write, but marks the order `queued` *before* SQS.
  A failed SQS call leaves the event missing and retry suppressed.
- **Recoverable:** `recovery/order_service.py` stores `pending` first,
  writes the receipt, publishes SQS and only then marks it `queued`.
  Replays resume pending work. A lost acknowledgement can still produce
  two queue messages.
- **Idempotent consumer:** the harness writes a DynamoDB marker keyed by the
  stable event ID using `attribute_not_exists(id)` before acknowledging SQS.
  Duplicate deliveries generate a single synthetic *consumer effect marker*.

The fault injector is a one-shot, **in-process SDK wrapper**, not an emulator
service outage. In `before-send`, it raises a synthetic RequestTimeout before
any SQS call. In `lost-ack`, it forwards a genuine SQS SendMessage to the
emulator and then raises RequestTimeout, simulating an acknowledgement that
was not received. All other S3, DynamoDB, and SQS operations reach the
emulator. The results prove this particular sequence and do not establish
global exactly-once delivery, broker durability, transactional guarantees,
IAM correctness, or AWS compatibility.

Run `aws-emulator-mcp failure-lab compare` (or `--json`) to see the original
failure and both recovery paths. All resources are synthetic, uniquely
named, and deleted after each scenario.
