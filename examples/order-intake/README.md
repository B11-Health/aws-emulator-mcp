# Order intake: the duplicate-event bug

This is a **real Python application sample** using botocore AWS clients, not a generated transcript. The same logical order is submitted twice, as happens when a client retries after a timeout. It uses **DynamoDB, S3 and SQS** and requires **only** the local signed AWS Emulator.

The `buggy/order_service.py` implementation unconditionally stores an order and publishes an SQS fulfillment event on **every** retry. The expected invariant is exactly one accepted order and one SQS fulfillment event for a successfully completed logical order.

The `fixed/order_service.py` version uses DynamoDB `PutItem` with `ConditionExpression=attribute_not_exists(#pk)`. It catches only `ConditionalCheckFailedException` as a duplicate and returns before S3/SQS side effects. The exact source diff is supplied in `reference.patch`; it can be applied in a **separate local copy** of the buggy file for inspection:

~~~sh
cp buggy/order_service.py order_service.py
patch -p1 < reference.patch
diff -u order_service.py fixed/order_service.py
~~~

To **execute both versions against the actual emulator** without mounting files or connecting to production AWS:

~~~sh
aws-emulator-mcp app-debug compare --json
aws-emulator-mcp app-debug buggy --json  # Exits 1: known failure is intentional
aws-emulator-mcp app-debug fixed --json
~~~

Or ask a trusted, local MCP agent to call `app_debug_catalog` for the source and patch; `app_debug_run` with `variant="compare"` produces the before/after proof. **Only the bundled, reviewed sample is executable**—there is no arbitrary code/patch upload, repo checkout, host mount, or remote command execution through this tool.

**Scope:** This addresses duplicates following a successful first write. It does *not* solve partial failures after the DynamoDB write, atomic delivery across DynamoDB/S3/SQS, concurrency across regions, FIFO deduplication guarantees, production IAM/KMS behavior or AWS API parity. A production design would need a durable transactional-outbox or repair worker plus application-specific tests.
