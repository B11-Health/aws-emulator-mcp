# Prove one Python application's AWS behavior, step by step

**Experimental, trusted-local and opt-in.** Introduced in a draft PR and **not
in the published beta.15 release**. This complements the official AWS
Emulator skill rather than installing or replacing it. No AWS account is
required for local checks.

Requirements: Node.js 20+ and Python 3.10+ for inspection; optional local
Docker with Linux containers and ample disk space for actual application
execution. Select **your own trusted** self-contained Python handler with
`handle(clients, inputs)` and literal SDK calls like
`clients['s3'].put_object(...)`. The AST scanner does not resolve aliases,
dynamic client names, sibling imports, or runtime control flow.

## 1. Inspect your own file, with no execution

```sh
node bin/aws-emulator-mcp.mjs app-guide examples/app-case/s3-upload.py --json
```

Output: SHA-256 of the selected source bytes, direct SDK operation candidates,
input-key names, and a deliberately **non-executable** `draftCase` sketch.
It does not import the developer module, start Docker, call AWS, or read AWS
credentials. Review the actual source yourself.

## 2. Create an incomplete draft without overwriting anything

```sh
node bin/aws-emulator-mcp.mjs app-guide examples/app-case/s3-upload.py \
  --draft my-app-case.json
```

The draft contains `reviewRequired: true`, synthetic-input placeholders,
and **empty** setup, checks and cleanup; it is unexecutable. Creation fails
if the output already exists, including a symlink. Edit the case yourself to
provide synthetic resource setup, SDK call counts, independently observable
post-invocation assertions, owned cleanup and a named regression assertion.
See [the S3 reference](../examples/app-case/s3-object-write.json) and the
[DynamoDB/SQS reference](../examples/app-case/sqs-idempotency.json).

## 3. Review the exact source and complete case

```sh
node bin/aws-emulator-mcp.mjs app-guide \
  examples/app-case/s3-upload.py examples/app-case/s3-object-write.json --json
```

For a recognized source plus valid case the status is
`explicit_approval_required`, with `formalCaseSchemaValidated: true` and an
empty `reviewGaps`. The CLI uses the runner's **actual declarative schema
validator** locally, then checks the scanner's observed calls and inputs
against the proposed case. Nothing is executed in the emulator at this step.

A draft with incomplete steps, unsupported fields, missing assertions,
unknown SDK patterns, or `REVIEW_ME` markers is **not approved**. The report
contains an `approvalToken` bound to the raw SHA-256 hashes of **both**
selected files. The token is not authentication and cannot establish code
safety; it simply prevents stale or accidental runs.

## 4. Run the test *only after personal review*

First inspect Docker readiness, and optionally build the locally verified
signed emulator image yourself:

```sh
node bin/aws-emulator-mcp.mjs preflight
node bin/aws-emulator-mcp.mjs build
```

The `app-guide` command **never automatically rebuilds an image**. A valid
approval without a matching cached image stops before executing user code.
When ready, supply the token shown in Step 3:

```sh
node bin/aws-emulator-mcp.mjs app-guide \
  examples/app-case/s3-upload.py examples/app-case/s3-object-write.json \
  --run --approve YOUR_APPROVAL_TOKEN --json
```

The run re-reads and verifies exact source/case bytes before selecting the
existing one-shot, `--network none` Docker lab. The trusted Python function
executes with synthetic inputs; independent SDK reads assert emulator state,
and declared cleanup is checked. The report returns scoped observed SDK calls,
assertions, source and case hashes, and cleanup without raw application
source, payloads, paths, or exception messages.

**A green result means only that one selected handler passed one reviewed
emulator case.** It does **not** prove the code was fixed, full application
coverage, IAM policy behavior or fidelity to production AWS. For before/after
bug-fix evidence use [app-case-compare](APP_CASE.md), which requires a failed
named regression before and independent assertions passing after.

## Reproducible recorded example

A [sanitized, project-maintained AWS Emulator 1.0.511 local run](evidence/guided-app-case-aws-emulator-1.0.511.json)
records the same S3 case against the bundled correct handler (1 SDK
PutObject success, independent ContentLength assertion passing) and a
separately approved intentionally incorrect handler (PutObject succeeded,
but ContentLength assertion failed). Both runs completed declared cleanup.
This is **not** AWS's own benchmark, an externally audited comparison or
proof of parity with production AWS. The committed evidence test checks its
source/case hashes and red/green interpretation.

## Limits and privacy

- Never run untrusted PR code. Docker containers with dropped capabilities
  are **not** a hostile-code sandbox; only execute source you own and trust.
- This is a **local CLI workflow**, not an MCP source-execution capability
  and not an automatic cloud deployment. No user AWS credentials are needed.
- Static inspection reports input **key names**, SDK call candidates and line
  numbers; review reports before sharing publicly.
- Source must be a regular, non-symlink UTF-8 `.py` file, maximum 20 KiB.
  Case must be a separate regular `.json` file up to 48 KiB with bounded
  setup, invocation, checks, cleanup and regression assertion.
- Valid case schema does **not** establish that a given SDK operation exists
  in the emulator or will have production AWS semantics.
- Avoid customer data. Use fresh, disposable synthetic resources only.

[Provide an independent reproducible test or onboarding report](https://github.com/B11-Health/aws-emulator-mcp/issues/26).
