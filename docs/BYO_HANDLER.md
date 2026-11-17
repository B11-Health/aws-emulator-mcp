# Test your own Python order handler locally

**First Bring Your Own App pilot:** a developer-selected Python function
against local signed AWS Emulator DynamoDB, S3 and SQS. This is a narrow
test for an order handler, **not** a general app/repository test framework.

## Run a real SDK test

Requires Node.js 20+, Git, and locally running Docker Desktop/Engine using
Linux containers. The first run builds a local image from the signed
AWS Emulator package (more than 1 GB of disk). No AWS account, AWS CLI,
production credentials or cloud deployment is required.

```sh
npm install -g "github:B11-Health/aws-emulator-mcp#v0.4.0-beta.15"
# The example source files are in the Git repository, not your working directory:
git clone --depth 1 --branch v0.4.0-beta.15 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp

# Should PASS: 1 accepted order, 1 SQS event, 8 assertions, 7 cleanup checks
aws-emulator-mcp app-verify examples/byo-order-handler/fixed.py --json

# Deliberately broken; expected exit 1: 2 accepted orders, 2 SQS events
aws-emulator-mcp app-verify examples/byo-order-handler/buggy.py --json
```

You can instead pass an absolute or relative path to **your own** local
`.py` handler from any working directory. The launcher does not download
application source or locate project files on your behalf.

[**Actual AWS Emulator 1.0.385 evidence**](evidence/byo-handler-aws-emulator-1.0.385.json)
records both runs, source SHA-256 values and sanitized assertion/cleanup
results. The runner does not expose the source, order, SDK responses, or
handler logs in the report. Each run creates fresh synthetic resources.

## Compare a developer-selected bug and fix, with PR-ready evidence

Beta.15 adds `app-compare`. In a beta.15 checkout, supply two different,
trusted local Python handler files:

```bash
node bin/aws-emulator-mcp.mjs app-compare \
  examples/byo-order-handler/buggy.py \
  examples/byo-order-handler/fixed.py
# Save a sanitized record for review, with source hashes and cleanup results:
node bin/aws-emulator-mcp.mjs app-compare \
  examples/byo-order-handler/buggy.py \
  examples/byo-order-handler/fixed.py --json > byo-comparison.json
# Or create a Markdown summary for the PR description:
node bin/aws-emulator-mcp.mjs app-compare \
  examples/byo-order-handler/buggy.py \
  examples/byo-order-handler/fixed.py --markdown > byo-comparison.md
```

The before file must demonstrate the specific duplicate-submission failure:
**two accepted submissions, two queue events, matching DynamoDB/S3 data,
verified emulator identity, and complete cleanup**. The after file must
suppress the duplicate while passing all eight assertions and all seven
cleanup checks. The command exits nonzero when either side is unverifiable.
It cannot claim success merely because an arbitrary before test failed.

Both runs are separate one-shot, network-disabled Docker containers, with
fresh synthetic resources. No production credentials, source files, or
application logs are copied into the report. The report retains only source
SHA-256 hashes, boolean results and bounded counters; it can be attached to a
pull request **after** the developer inspects it. A third-party PR workflow
must **not** auto-execute untrusted source: use this command locally against
code you own or have reviewed. There is deliberately no MCP or PR Action
entrypoint for the executable-source feature.

Comparing two handlers still tests one completed-request retry per run; it
does **not** prove crash recovery, arbitrary application support or AWS parity.

## Handler interface and data

Supply one UTF-8 **regular** `.py` file (max 20 KiB; no symlinks) defining:

```python
def submit_order(dynamodb, s3, sqs, *, table, bucket, queue_url, order):
    # Botocore clients and synthetic resource IDs are injected.
    # Use your actual order-processing SDK logic here.
    # Return {"accepted": True} for a new order, False for a duplicate.
    ...
```

The synthetic order includes `id`, `sku`, `quantity`,
`tenantId`, `customerId`, `currency`, `totalCents` and `lineItems`.
The handler must use the injected DynamoDB table (key `id`) and persist
`sku`, `status="queued"`, `tenantId`, `customerId`, `currency`,
numeric `totalCents` and numeric `lineCount` attributes. It must
upload the canonical JSON receipt at `receipts/<id>.json` into S3 and
send exactly one matching SQS event, even when the handler is invoked
twice for the same successfully processed order.

See the readable [buggy](../examples/byo-order-handler/buggy.py) and
[fixed](../examples/byo-order-handler/fixed.py) implementations.

The runner verifies eight assertions: initial submission, duplicate
suppression, one accepted order, one matching queue event, presence of
the DynamoDB order record, typed business fields, and a matching S3
receipt. Seven cleanup/absence checks verify resource teardown.
All must pass for exit 0.

## Security and honesty

- **Run only local Python you own and trust.** It executes actual selected
  source code, including Python imports. Docker reduces exposure but is
  **not a security boundary for actively hostile code**. Do not run
  unreviewed pull requests or third-party/customer source.
- This opt-in local CLI command is **not an MCP tool** or GitHub Action
  capability. Neither AI agents nor PR contributors can trigger arbitrary
  code execution through the published MCP or PR review Action.
- The launcher rejects URLs, symlinks, oversize files, invalid UTF-8 and
  non-local Docker daemon endpoints before invoking a worker. It sends
  the source and its SHA-256 through container stdin; the source is
  never passed via command arguments, environment variables or bind mounts.
- The one-shot Docker container runs as unprivileged UID with
  `--network none`, all capabilities dropped, `no-new-privileges`,
  a PID limit, and 2 GiB memory limit. The worker has a 150-second
  deadline. No host AWS credentials are forwarded.
- Local emulator identity **000000000000** must be verified before
  the selected Python is imported. Any original source exception,
  logs and raw SDK bodies are omitted from emitted JSON.
- This checks **one completed-request retry only**, not a crash mid-write.
  The conditional-write example is **not a transactional outbox**.
  AWS account parity, IAM enforcement, real AWS deployment, concurrency,
  network outages and end-to-end codebase testing are **not** verified.

## Next step

A genuinely generic Bring Your Own App adapter would need a versioned
app/build specification, stricter untrusted-code execution design,
custom assertions and reproducible failing/passing evidence. **That
general-purpose runner is not shipped yet.**

Share only synthetic, nonprivate examples through the
[developer feedback thread](https://github.com/B11-Health/aws-emulator-mcp/issues/26).
