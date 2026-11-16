# Failure Lab — test what happens when an AWS response never arrives

A successful API call doesn't tell you what happens if the application cannot
tell whether it succeeded. Retry behavior is where duplicate events, missing
jobs and unexpected work often originate.

Failure Lab demonstrates this with a **reviewed Python application** calling
DynamoDB, S3 and SQS in the official local AWS Emulator. No AWS account is
required.

## Run the experiment

Install the beta GitHub source package following [Get started](../README.md#get-started).
Then run:

```bash
aws-emulator-mcp failure-lab compare
aws-emulator-mcp failure-lab compare --json > failure-evidence.json
```

Your AI assistant can also call `failure_lab_catalog` to inspect the scenario
definitions, complete reviewed application source, unified diff and source hashes, and `failure_lab_run` with
`{"scenario":"compare"}` to execute it over the local Docker MCP connection.

The original SQS scenarios are `fragile-before-send`, `recover-before-send`,
and `recover-lost-ack`. The source-branch addition includes
`fragile-before-receipt`, `recover-before-receipt` and `partial-compare`.
No caller-provided paths, code, scripts, endpoints,
credentials or arbitrary fault specifications are accepted.

## New partial-write scenario: DynamoDB saved, receipt never uploaded

From a checkout containing this change (**not the published beta.14 tag**), run:

```bash
node bin/aws-emulator-mcp.mjs failure-lab partial-compare
node bin/aws-emulator-mcp.mjs failure-lab partial-compare --json > partial-evidence.json
```

The harness creates fresh synthetic DynamoDB, S3 and SQS resources for each
reviewed application variant, then wraps **only the first S3 PutObject** to
throw `RequestTimeout` **before forwarding it**. The DynamoDB order write
already succeeded; the S3 receipt and SQS event do not exist when the failure
occurs. Then the harness retries the exact same order against the retained
state and checks the results through actual emulator APIs.

| Application | State after failure | S3 after retry | SQS after retry |
| --- | --- | --- | ---: |
| Fragile conditional-write guard | `queued` (premature) | Receipt still missing | 0 |
| Recoverable pending-state producer | `pending` | Receipt restored and verified | 1 |

The recovered run also verifies exactly one synthetic consumer marker and all
seven teardown checks. Counts are expected outcomes; **only live runs passing
CI should be described as observed emulator evidence**. This does not kill
an application process or simulate real S3 downtime: the exception is injected
at the SDK boundary, while DynamoDB and subsequent successful S3/SQS calls
execute against AWS Emulator. It is not proof of transactional-outbox atomicity.

## Three related failures and recoveries

| Scenario | What actually happens | SQS messages | Consumer markers |
| --- | --- | ---: | ---: |
| **Fragile before send** | DynamoDB row says queued; an injected pre-send timeout prevents SQS delivery; retry skips it | 0 | 0 |
| **Recover before send** | DynamoDB row remains pending; retry sends once and changes status to queued | 1 | 1 |
| **Recover after lost acknowledgement** | First SQS send actually reaches the emulator; an injected response failure triggers a retry; consumer ignores the duplicate by stable event ID | 2 | 1 |

These counts were observed locally on signed AWS Emulator **v1.0.385**
(November 14, 2026). The reproducible runner reports the exact emulator
version it observes when you rerun the tests.

[Inspect the captured JSON assertion and cleanup evidence](evidence/failure-lab-aws-emulator-1.0.385.json).
This is a snapshot of one recorded local run, not a claim about later emulator versions.

### Where is the fault injected?

The `InjectSendFailure` wrapper intercepts one `sqs.send_message` call:

- **Before send:** throws a synthetic `RequestTimeout` without forwarding
  that one API request. The second call reaches the actual emulator.
- **After send:** forwards the first SQS `SendMessage` to the actual
  emulator, then throws `RequestTimeout` to model a lost acknowledgement.
  A retry makes a second, actual emulator send.

S3, DynamoDB and non-faulted SQS operations are genuinely executed against
the local emulator. **This is a controlled SDK-boundary failure, not a claim
that AWS Emulator itself dropped a network packet or was unavailable.**

## Inspect the application

- [Existing retry guard](../examples/order-intake/fixed/order_service.py)
- [Recoverable order submission](../examples/reliability-lab/recovery/order_service.py)
- [Application's reliability notes](../examples/reliability-lab/README.md)
- [Failure injector and independent assertions](../src/aws_emulator_mcp/failure_lab.py)

The recoverable sample persists `pending` work before publishing a message,
then marks it `queued` only after the SDK returns successfully. A retry can
resume unfinished work. If a successful publish loses its acknowledgement,
duplicates are possible. The event carries a stable `eventId`. The synthetic
consumer records a DynamoDB marker using a conditional write **before**
acknowledging each SQS delivery.

A single marker is not the same as proving one production fulfillment action:
there is no real payment or shipment. For real deployments, combine
transactional outbox persistence with proper recovery workers, retries,
consumer idempotency, visibility timeouts and operational monitoring.

## Evidence and cleanup

The JSON report contains the scenario, emulator version, account verification,
one-shot fault timing, queue event count, durable state before/after retry,
consumer effect-marker counts, assertion pass/fail and seven resource cleanup
checks per run. `compare` uses unique S3, DynamoDB and SQS resources in each
of its three scenarios. All experiment-created resources are deleted.

The Docker runtime has no external container network, host mounts, AWS account
keys or public ports. Like the other application demos, Failure Lab only
executes packaged reviewed source files and synthetic values.

This lab tests narrow, reproducible recovery behavior. It does **not** claim
full AWS API parity, IAM security correctness, exactly-once broker delivery,
atomic transactions, arbitrary user-source execution or a true AWS outage.
