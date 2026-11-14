# Debug a real AWS-backed Python application in the local MCP lab

**AWS Emulator MCP v0.4.0-beta.6 GitHub-source beta.** This is an executable
Python application debugging case, **not a transcript of an AI claiming it
fixed something**. Two application modules make real DynamoDB, S3 and SQS
calls through the official AWS Emulator in isolated Docker.

## The defect

The same logical order is submitted twice, as happens when a client retries
after a timeout. The deliberately buggy implementation unconditionally writes
an order and publishes an SQS fulfillment event on **each** call. The expected
invariant is **one accepted submission and one fulfillment event** after
a successfully processed order, even if the request is retried.

| Result after two identical submissions | Broken | Reference fix |
|:--|--:|--:|
| Accepted submissions | **2 (FAIL)** | **1 (PASS)** |
| SQS events received | **2 (FAIL)** | **1 (PASS)** |
| DynamoDB order and S3 receipt validated | PASS | PASS |
| Cleanup checks for synthetic resources | 7/7 | 7/7 |

The app performs the writes via actual AWS SDK clients. The independent
test harness reads DynamoDB and S3 and receives and acknowledges SQS messages.
Individual assertions and cleanup outcomes—not just a summary—are returned.

[Inspect the recorded real-emulator v1.0.365 JSON evidence](evidence/app-debug-aws-emulator-1.0.365.json). It is a dated snapshot; later emulator releases can behave differently.

## Run the reproducible debugging loop

Requires Node.js 20+, local Docker and AWS Emulator MCP installed from GitHub.
No AWS account or production credentials.

~~~bash
npm install -g "github:B11-Health/aws-emulator-mcp#master"

aws-emulator-mcp app-debug compare
aws-emulator-mcp app-debug compare --json > order-debug-evidence.json

# Deliberately broken application; expected exit status 1.
aws-emulator-mcp app-debug buggy --json

# Independently verify the packaged reference fix.
aws-emulator-mcp app-debug fixed --json
~~~

The comparison exits 0 only when the buggy implementation **actually**
duplicates accepted orders/messages, the packaged reference fix passes
the same invariants, and both runs verify their resource cleanup.

### Let your coding agent investigate

Connect a trusted local MCP client with `aws-emulator-mcp config vscode`,
then give it this task:

> Call `app_debug_catalog` and inspect the buggy Python source and
> acceptance criteria. Call `app_debug_run` with
> `{"variant":"buggy"}` to reproduce the actual failure.
> Explain which invariants failed and propose the minimal fix.
> Call `app_debug_run` with `{"variant":"compare"}`
> to verify the reviewed reference patch against fresh isolated resources.
> Compare your proposal with the returned unified diff. Do not claim your
> own generated patch was executed unless you separately tested it.

The two additional Docker-only MCP tools are `app_debug_catalog`
(read-only source and task description) and `app_debug_run`
(execute packaged `buggy`, `fixed` or `compare`).
The native 29-tool adapter remains unchanged; isolated Docker has **34 total**.

## Inspect and apply the actual patch

- [Buggy application](../examples/order-intake/buggy/order_service.py)
- [Corrected application](../examples/order-intake/fixed/order_service.py)
- [Exact unified diff](../examples/order-intake/reference.patch)
- [Sample application README](../examples/order-intake/README.md)
- [Emulator-backed test harness](../src/aws_emulator_mcp/app_debug.py)

Apply the patch only in a disposable local source copy:

~~~bash
cd examples/order-intake
cp buggy/order_service.py order_service.py
git apply reference.patch
diff -u order_service.py fixed/order_service.py
~~~

The corrected implementation uses DynamoDB `PutItem` with
`ConditionExpression=attribute_not_exists(#pk)` and returns early
only on `ConditionalCheckFailedException`. Other SDK errors are
re-raised. The code cannot process the same *successfully completed* order
twice without detecting the duplicate first.

## What the evidence means

Reports contain `case`, `variant`, `passed`,
`bugReproduced`, `referenceFixVerified`, individual
`before` and `after` assertions, observed event counts,
cleanup results and a SHA-256 of the exact reference patch.

Every sample uses uniquely named resources inside the network-isolated,
signed-emulator Docker image. There are **no host mounts, published ports,
production AWS credentials, external container network, arbitrary source
submissions or remote repository execution**.

**Important limitation:** This prevents duplicate effects after a
*successfully completed* DynamoDB conditional write. A crash after DynamoDB
is updated but before SQS publishes can still lose an event; production
systems need a transactional-outbox/recovery approach, idempotent consumers,
retries and least-privilege IAM. This sample does **not** test real AWS IAM,
KMS, exactly-once delivery, service parity or arbitrary agent-generated
code patches. A safely opted-in user-repository runner is future work.
