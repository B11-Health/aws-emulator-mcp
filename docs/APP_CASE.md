# Verify a trusted Python application function against AWS Emulator

**Experimental, local-only.** Point the CLI at **your own, explicitly selected**
Python function and a separate, reviewed JSON behavior case. It executes the
function in a one-shot, network-disabled Docker lab with verified emulator
identity, counts its SDK calls, and checks its actual emulated AWS state with
**separate SDK requests**. Your function's return value cannot make a failed
independent assertion pass.

This is a first bounded app-level scenario runner, **not** a general
repository/pytest runner, hostile-code sandbox, AWS IAM test or production AWS
fidelity check. It does not read or import arbitrary project files for you.

## Inspect a proposed case before running code (new, read-only)

If you have a selected Python `handle(clients, inputs)` module, begin with
**static inspection**, not with Docker or source execution:

```sh
# Requires host Python 3.10+; does not import or run the selected app.
node bin/aws-emulator-mcp.mjs app-case-inspect \
  examples/app-case/s3-upload.py --json

# Cross-check a separately authored behavior case's entrypoint, inputs and
# expected call counters. This still does not run AWS APIs or the app.
node bin/aws-emulator-mcp.mjs app-case-inspect \
  examples/app-case/s3-upload.py \
  examples/app-case/s3-object-write.json --json
```

The inspector reports a source SHA-256, the *literal* SDK calls it can see,
the named input keys, unrecognized access patterns, optional expected-counter
gaps and related examples. Its `starterCase` is an **intentionally invalid,
unexecutable sketch**: it has `reviewRequired: true`, empty `setup`, `checks`
and `cleanup`, plus `REVIEW_ME` fields. Inspect the original app, replace
synthetic inputs, write meaningful independent assertions and cleanup, remove
`reviewRequired`, and review the entire contract before selecting the trusted
source for `app-case`. No auto-drafted test is marked passing.

This first-pass AST matcher recognizes only direct
`clients["service"].sdk_method(...)` expressions inside one selected
public `function_name(clients, inputs)` function. The default name is `handle`;
if you provide a case, its `invoke.entrypoint` selects the function, or use
`--entrypoint NAME` to inspect a named function without a case and literal `inputs["name"]` or
`inputs.get("name")` keys. It cannot infer aliases, dynamic client
identifiers, nested function execution, real control-flow reachability,
actual AWS operation-model support, or full project runtime dependencies.
`project-plan` separately recognizes selected direct Boto3 client calls
in a Python project. Neither static analysis feature executes source.

## A real failing/passing application scenario

Requirements: Node.js 20+, local Docker (Linux containers), enough storage for
the official signed AWS Emulator image. No AWS credentials or cloud account.

From the development Git checkout containing this feature:

```sh
# Two actual function invocations, independent DynamoDB and SQS reads,
# and scoped cleanup after success or failure.
node bin/aws-emulator-mcp.mjs app-case examples/app-case/fixed.py \
  examples/app-case/sqs-idempotency.json --json

# Expected exit 1: the broken handler sends two queue messages.
node bin/aws-emulator-mcp.mjs app-case examples/app-case/buggy.py \
  examples/app-case/sqs-idempotency.json --json

# Compare two trusted source revisions against the **same case**.
node bin/aws-emulator-mcp.mjs app-case-compare \
  examples/app-case/buggy.py examples/app-case/fixed.py \
  examples/app-case/sqs-idempotency.json --json

# Use --markdown for concise PR-ready, human-reviewed evidence.
node bin/aws-emulator-mcp.mjs app-case-compare \
  examples/app-case/buggy.py examples/app-case/fixed.py \
  examples/app-case/sqs-idempotency.json --markdown
```

The sample calls a Python `handle(clients, inputs)` twice. The fragile
implementation overwrites a DynamoDB item and sends an SQS message on **both**
invocations. The corrected implementation uses a DynamoDB conditional write
and sends only once. A separate SDK read asserts that the order was stored,
that its typed fields match and that the queue contains **no second message**.
The intentionally broken version fails at `receive.Messages.1`; the fixed
version passes the same assertion. Both must clean up their ephemeral queue
and table. No developer-controlled return flag can override the result.

[Recorded signed-emulator 1.0.506 evidence](evidence/app-case-aws-emulator-1.0.506.json)
shows the before/after calls, independent checks, source hashes and emulator
version. The source and raw payloads are not included in the report.

## Independent S3 example: corrupted object length

The second sample exercises a different AWS service and a different invariant.
`examples/app-case/s3-upload-bug.py` writes 13 bytes where the reviewed case
expects 12. `examples/app-case/s3-upload.py` writes the expected 12 bytes.
Both run through the **same local runner**, with independent `HeadObject`
response assertions and scoped object/bucket cleanup:

```sh
node bin/aws-emulator-mcp.mjs app-case-compare \
  examples/app-case/s3-upload-bug.py examples/app-case/s3-upload.py \
  examples/app-case/s3-object-write.json --json
```

The actual local test on signed AWS Emulator **1.0.506** reproduced the
`head.ContentLength` failure before the fix and verified it afterward.
[Inspect the sanitized S3 evidence](evidence/app-case-s3-aws-emulator-1.0.506.json).
This is an assertion on one synthetic object; not a complete S3 test suite.

## Bring your own module and case

Supply a trusted, regular UTF-8 `.py` file (max 20 KiB, no symlinks) defining:

```python
def handle(clients, inputs):
    queue_url = inputs["queueUrl"]
    clients["sqs"].send_message(QueueUrl=queue_url, MessageBody=inputs["body"])
```

This is real Python executed inside the selected local Docker lab. It may use
installed Python dependencies, but this first version does **not** install
packages or import sibling files from your host project. Use a self-contained
module or a reviewed thin adapter if your original app is more complex.
Only clients in the case's `services` list are injected. Calls through those
clients are observed and counted without recording argument values. Expected
SDK operations must have at least one successful call; a caught exception
counts as an attempt but cannot alone satisfy the expected operation. A source
module can import dependencies already bundled in the container; this is not
a general project packaging system.

The case JSON contains:

- `setup`: 1–8 declared AWS SDK operations to create synthetic resources
- `invoke`: exact function name, invocation count (1–3), synthetic inputs and
  1–8 minimum/maximum SDK operation-count expectations
- `checks`: 1–8 independent SDK reads/assertions against the emulator state
- `cleanup`: 1–8 teardown operations, attempted even when checks fail
- `regression`: one precise check step ID and response assertion path that
  the broken version must fail and the corrected version must pass

Combined setup/check/cleanup is limited to 16 steps. Every operation and
assertion uses the validated, declarative `contract_run` JSON subset:
`{"$fixture":"queue"}` generates an ephemeral name; `{"$ref":"queue.QueueUrl"}`
refers to a prior SDK response. No shell commands, host paths, URLs, custom
network endpoints, arbitrary code snippets or fault-injection operators are
accepted in the case. The only executable content is your explicitly selected
local Python module, never material supplied by the case JSON.

Review [the example case](../examples/app-case/sqs-idempotency.json) before
adapting it to your own handler. Additional AWS SDK operations may be modeled
but unimplemented in the emulator; test each real workflow, don't infer parity
from botocore's service models.

## Evidence interpretation

| Field | What it establishes |
| --- | --- |
| `sourceInvoked` | The selected Python function was called inside the lab |
| `sdkCalls` | Actual attempts/successes made through injected clients |
| `checks[].assertions` | Independent SDK reads matched their declared expectations |
| `cleanupPassed` | Declared cleanup completed, even following a failed assertion |
| `bugReproduced` | Before source failed **only** the named assertion with other checks green |
| `fixVerified` | After source, under the same case and emulator version, passed the checks and cleanup |
| `productionAwsValidated` | Always `false`; this is not production AWS parity |

The comparison requires **different verified source hashes**, the same
case hash, matching emulator versions, a specifically failed regression
assertion in the broken run, passing independent checks after the fix,
and complete cleanup on both runs. An unrelated API error, handler exception,
missing test, changed case, or unknown source execution is not a verified bug.

## Trust boundary and limitations

- **Only run code you own and trust.** Docker and `--network none` do not make
  malicious Python or native dependencies safe. Review source before using.
- **Never an MCP or GitHub PR Action tool.** The remote MCP only accepts
  declarative AWS operation plans; it cannot run developer source.
- Selected Python source, expected inputs and case are sent via Docker stdin,
  never file mounts, command arguments, environment credentials or URLs.
- The container uses an unprivileged UID, local-only verified emulator
  account `000000000000`, dropped Linux capabilities, `no-new-privileges`,
  PID and memory limits, and an execution deadline. There are no real AWS
  credentials or production API calls.
- Output never includes raw source, local file paths, business inputs, API
  request/response bodies, exception messages or application logs by default.
  Path labels and operation names from the developer's own case remain visible;
  review these before publicly sharing evidence.
- SQS delivery and approximate behaviors may differ from real AWS. Test
  snapshots are project-maintained. No claim of independent external adoption.
- This covers one selected entrypoint, synchronous invocations and selected
  local SDK assertions—not arbitrary multi-file projects, concurrency,
  process crashes, real network outages, IAM enforcement or exhaustive testing.
