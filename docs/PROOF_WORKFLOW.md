# Prove a Python application fix against local AWS Emulator

**Goal:** show what your application did before a change, which independent assertion failed, and whether the same assertion passed after the fix.

The draft [Application Proof Explorer](proof-explorer.html) reads two **project-maintained**, redacted November 18, 2026 comparisons. **This new page is not available on GitHub Pages until its source is merged and the site deploys.** Preview it locally using the instructions below. It is a static evidence viewer, not an AWS-connected simulator. [SQS record](evidence/app-case-aws-emulator-1.0.506.json) · [S3 record](evidence/app-case-s3-aws-emulator-1.0.506.json).

Before advertising the public URL, follow the [Pages prelaunch and post-deploy integrity gate](PAGES_LAUNCH_GATE.md). The public Explorer is not yet deployed.

## Preview the Proof Explorer before GitHub Pages publishes it

From a checkout containing the draft Proof Explorer source:

```sh
python3 -m http.server 8788 --bind 127.0.0.1 --directory docs
```

Open `http://127.0.0.1:8788/proof-explorer.html` in your browser. This serves only local, checked-in static files and the project-maintained evidence JSON. It does **not** start Docker, contact AWS, run an application, or verify production behavior. Stop the local server with Ctrl+C. On a system where `python3` is named `python`, substitute that executable. After the page is deployed to GitHub Pages, its expected public address is `https://b11-health.github.io/aws-emulator-mcp/proof-explorer.html`; do not treat that address as live before deployment.

This is an experimental local Python `handle(clients, inputs)` proof workflow available in a development checkout **containing these features**, including the integrated preview. It is **not in v0.4.0-beta.15**, an arbitrary application runner, or an MCP tool for executing source. Only run source you own and trust; Docker does **not** make hostile code safe.

## One workflow, three levels of evidence

| Stage | Needs | What passed evidence means | What it cannot prove |
| --- | --- | --- | --- |
| Offline first check | Git, Node.js 20+ | Seven architecture artifacts and checksums verified | Not executed AWS APIs or Python |
| Static app-case inspection | Also Python 3.10+ | Literal SDK calls and input names identified in one selected function | No source execution, no semantics or SDK fidelity |
| Trusted local comparison | Also Docker Linux containers, sufficient storage, initial package download | Same reviewed invariant fails before and passes after; independent emulated state checks and declared cleanup passed | Not AWS production fidelity, IAM, whole-app correctness or hostile-code isolation |

No AWS account, production credentials or AWS CLI is needed for any stage.

## 1. First success without Docker or AWS

~~~sh
git clone --depth 1 --branch master https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs try --json
~~~

On a sanitized Node v22.23.1 runner on November 18, 2026, this returned `passed: true`, `artifactCount: 7`, `syntheticContractSteps: 14`, `dockerUsed: false`, and `cloudCallsMade: false`. The 14-step contract was **generated but not run**. This command exercises the offline architecture generator, not the emulator. If Docker is unavailable, this remains a valid, intentionally limited first step.

## 2. Inspect a selected, trusted Python handler before running it

~~~sh
node bin/aws-emulator-mcp.mjs app-case-inspect \
  examples/app-case/fixed.py examples/app-case/sqs-idempotency.json --json
~~~

The inspected reference case found `handle`, literal `dynamodb.PutItem` and `sqs.SendMessage` call sites, and input keys `body`, `id`, `queueUrl` and `table`. It returned `executedSource: false`, `executedAWSCalls: false` and `caseReadyToRun: false`. The last flag means that the **auto-suggested starter** is deliberately incomplete. The separately hand-authored example JSON is a different artifact; review it before use.

Static analysis cannot detect every alias, dynamic call, helper method or installed dependency. Read [the inspector's exact limits](APP_CASE.md#inspect-a-proposed-case-before-running-code-new-read-only).

## 3. Falsify the bug, then verify the fix with one invariant

Check Docker readiness first with `node bin/aws-emulator-mcp.mjs preflight --json`; follow the [onboarding prerequisites](ONBOARDING.md#check-prerequisites-before-building-the-image) for local Linux-container Docker. No cloud account or real keys are needed. Run only **developer-approved** source:

~~~sh
node bin/aws-emulator-mcp.mjs app-case-compare \
  examples/app-case/buggy.py examples/app-case/fixed.py \
  examples/app-case/sqs-idempotency.json --json
~~~

The sample calls the Python function twice with the same logical order. The broken source writes to DynamoDB and sends **two** SQS messages. The corrected source uses DynamoDB `attribute_not_exists(id)` and sends **one**. Independent emulator reads check the stored order and whether `receive.Messages.1` exists. This is not an application-provided “passed” flag.

The [saved AWS Emulator 1.0.506 record](evidence/app-case-aws-emulator-1.0.506.json) has:

| Observed outcome | Buggy | Fixed |
| --- | --- | --- |
| Successful application `sqs.SendMessage` calls | 2 | 1 |
| Independent SDK assertions passed | 3/4 | 4/4 |
| Named `receive.Messages.1` assertion | **FAIL** | **PASS** |
| Declared resource cleanup | **PASS** | **PASS** |
| Source SHA-256 | Distinct | Distinct |
| Case SHA-256, emulator version | **Same** | **Same** |
| Production AWS validated | **false** | **false** |

In the saved machine-readable comparison, `productionAwsValidated: false` is explicit even when `bugReproduced` and `fixVerified` are true.

For a second independent invariant in the same local runner, compare an S3 upload that stores 13 bytes against a fix that stores 12:

~~~sh
node bin/aws-emulator-mcp.mjs app-case-compare \
  examples/app-case/s3-upload-bug.py examples/app-case/s3-upload.py \
  examples/app-case/s3-object-write.json --json
~~~

A separate `HeadObject.ContentLength` read fails before and passes after. [Saved S3 result](evidence/app-case-s3-aws-emulator-1.0.506.json).

## 4. Bring your own trusted function

Review [the supported function ABI, schema and safety limits](APP_CASE.md#bring-your-own-module-and-case). This first version accepts one explicit regular UTF-8 Python module (max 20 KiB), with `handle(clients, inputs)`, plus a separately reviewed JSON test case. It does not import sibling host files or install application dependencies. You may need a reviewed, thin adapter to make your code use injected clients.

Before opting in locally:

1. Write an **observable application invariant**, not merely “SDK call succeeded” or a return flag.
2. Use synthetic setup, invocation inputs and bounded expected SDK call counts. Never use real customer records or AWS credentials.
3. Add **independent SDK state reads** under `checks`, and explicit `cleanup` for all synthetic resources.
4. Require a **red baseline** with exactly the named regression failure, followed by a **green fix**, on the same case and emulator version with distinct source hashes.
5. Disqualify missing source execution, unrelated exceptions, changed expectations, incomplete cleanup or ambiguous results.

This cannot be initiated through the remote MCP server or untrusted GitHub PR Actions. Container restrictions lower accidental exposure; they are not security guarantees against malicious input.

For a human-reviewed PR summary, rerun the comparison with `--markdown` instead of `--json`. Review and redact any identifying case labels before sharing. A narrow honest claim is: “One selected trusted Python handler's named regression was reproduced and fixed against local AWS Emulator 1.0.506, with separate state checks and scoped cleanup.” Do not call it AWS certification, IAM validation or general project correctness.

## When a different tool is simpler

The [official AWS Emulator agent skill](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-agent.html) already installs/connects SDKs and can check project operation compatibility against [AWS fidelity information](https://docs.aws.amazon.com/emulator/latest/userguide/check-project.html). Prefer native SDK/CLI tooling when that meets your needs. [LocalStack MCP](https://github.com/localstack/localstack-mcp-server) documents broader deployment/log/chaos workflows but requires its auth token; [Moto](https://docs.getmoto.org/en/latest/docs/getting_started.html) is a useful Python mocking approach. This adapter's narrower extra is reviewable, sanitized evidence for a bounded trusted-local application invariant. It cannot improve the upstream emulator's AWS fidelity.

For **independent** feedback, use the [field report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml), including OS/runtime versions, the exact command and exit code, sanitized evidence, whether your own function was used, and why you would or would not adopt it. Do not submit credentials, private source or business payloads.
