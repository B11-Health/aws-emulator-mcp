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

Run the examples **from the repository's source-checkout root** (where `bin/`
and `docs/` exist). Replace `my-handler.py` with a Python handler you own and
have reviewed; create that file yourself before inspecting it. Paths are
quoted to accommodate spaces. Choose local paths only: **UNC network shares,
Windows device paths, and remote URLs are rejected**, including when this
CLI runs on Linux. Bash and PowerShell examples below are separate, not
commands to paste together. None of the examples below runs your Python code
unless you explicitly invoke the `--run --approve` step.

## 1. Inspect your own file, with no execution

**Bash / POSIX shell**

```sh
node "./bin/aws-emulator-mcp.mjs" app-guide "./my-handler.py" --json
```

**Windows PowerShell (single command)**

```powershell
node ".\bin\aws-emulator-mcp.mjs" app-guide ".\my-handler.py" --json
```

Output: SHA-256 of the selected source bytes, direct SDK operation candidates,
input-key names, and a deliberately **non-executable** `draftCase` sketch.
It does not import the developer module, start Docker, call AWS, or read AWS
credentials. Review the actual source yourself.

## 2. Create an incomplete draft without overwriting anything

**Bash / POSIX shell**

```sh
node "./bin/aws-emulator-mcp.mjs" app-guide "./my-handler.py" --draft "./my-app-case.json" --json
```

**Windows PowerShell (single command)**

```powershell
node ".\bin\aws-emulator-mcp.mjs" app-guide ".\my-handler.py" --draft ".\my-app-case.json" --json
```

The draft contains `reviewRequired: true`, synthetic-input placeholders,
and **empty** setup, checks and cleanup; it is unexecutable. Creation fails
if the output already exists, including a symlink. Edit the case yourself to
provide synthetic resource setup, SDK call counts, independently observable
post-invocation assertions, owned cleanup and a named regression assertion.
See [the S3 reference](../examples/app-case/s3-object-write.json) and the
[DynamoDB/SQS reference](../examples/app-case/sqs-idempotency.json).

### Optional: create a focused state-proof pair for your own handler

Instead of the empty `--draft` starter, `--draft-proof` provides a narrower
bridge for **one unambiguous literal** `clients[service].method(...)` write:
`S3 PutObject`, `SQS SendMessage`, or `DynamoDB PutItem`. No dynamic clients,
multi-operation handlers, URLs, or inferred business logic are accepted.

**Bash / POSIX shell**

```sh
node "./bin/aws-emulator-mcp.mjs" app-guide "./my-handler.py" --draft-proof "./my-proof.json" --json
```

**Windows PowerShell (single command)**

```powershell
node ".\bin\aws-emulator-mcp.mjs" app-guide ".\my-handler.py" --draft-proof ".\my-proof.json" --json
```

The read-only scan creates **two new files** (neither overwrites an existing
file or symlink): `my-proof.json` and `my-proof.expected-red.json`. The first
suggests a synthetic resource setup, one independent SDK state read and scoped
cleanup. The second is identical **except that the same named post-state
assertion is deliberately inverted** (`exists: true` -> `exists: false`).
These are an *editable proposal*, **not an assertion that your handler behaves
this way**:

| Detected literal call | Suggested owned setup | Independent check | Owned cleanup |
| --- | --- | --- | --- |
| `s3.PutObject` | `CreateBucket` with a generated fixture name | `HeadObject.ContentLength` exists | `DeleteObject`, then `DeleteBucket` |
| `sqs.SendMessage` | `CreateQueue` with a generated fixture name | `ReceiveMessage.Messages.0.Body` exists | `DeleteQueue` |
| `dynamodb.PutItem` | `CreateTable` with suggested `id` string key | `GetItem.Item.id.S` exists | `DeleteTable` |

**You must inspect and edit both JSON files.** Their `reviewRequired: true`
field deliberately violates the executable case schema. All discovered input
keys are set to `REPLACE_WITH_SYNTHETIC_VALUE`, and S3's object key is
`REVIEW_ME_SYNTHETIC_OBJECT_KEY`. Map actual handler arguments to fresh
`$fixture`/`$ref` values and synthetic body values, confirm the DynamoDB key
schema and SQS delivery assumptions, set matching S3 keys for writing,
asserting and cleanup, and review every cleanup operation. Do not reuse an
existing bucket, queue, table or customer data. Only after you have personally
verified the full case should you remove `reviewRequired` and replace all
review markers. **Creating drafts never approves or runs either case.**

Creating either draft **does not make it runnable**. It cannot produce an
approval token while `reviewRequired` or unresolved placeholders remain.
Only after personally reviewing the handler, both cases, resource ownership,
fixture mappings and cleanup should you remove `reviewRequired` from **each**
JSON file and continue to Step 3. The positive case and the deliberately
inverted expected-red case receive **different approval tokens**; do not
reuse a token across files. `--run --approve TOKEN` is an additional,
separate explicit action requiring local Docker and the signed emulator image.

**Expected-red is a sensitivity control, not a bug-fix verdict.** After a
passing positive baseline, run the independently reviewed negative case in a
**separate disposable lab**. It should exit nonzero because the *named check
assertion* is false **while** the selected handler ran, its required SDK write
succeeded, setup worked and owned cleanup passed. An error from startup,
missing SDK model support, failed cleanup or an unreachable assertion is **not**
a detected negative control. If the negative case unexpectedly passes, revisit
the test assumptions rather than claiming that a repair was proven. Before/
after proof still requires the separate `app-case-compare` workflow using a
shared reviewed invariant.

This optional generator does not import your module, deduce application
business intent, install dependencies, call AWS, run Docker, or add source
execution through MCP/CI. The generated `exists` checks prove only the
presence of an object/message/item; strengthen them with an exact synthetic
expected value (`equals`) before making a business-level correctness claim.
It is deliberately limited to one literal SDK call; for multi-service workflows
author and review the existing declarative case format manually using
[APP_CASE.md](APP_CASE.md).

## 3. Independently review both completed cases and obtain two tokens

After editing and reviewing **both** generated cases, inspect the positive
case and expected-red control **separately**. These commands perform static
inspection and case-schema validation; they do **not** run source or Docker.

**Bash / POSIX shell**

```sh
node "./bin/aws-emulator-mcp.mjs" app-guide "./my-handler.py" "./my-proof.json" --json
node "./bin/aws-emulator-mcp.mjs" app-guide "./my-handler.py" "./my-proof.expected-red.json" --json
```

**Windows PowerShell (each line is an independent, portable command)**

```powershell
node ".\bin\aws-emulator-mcp.mjs" app-guide ".\my-handler.py" ".\my-proof.json" --json
node ".\bin\aws-emulator-mcp.mjs" app-guide ".\my-handler.py" ".\my-proof.expected-red.json" --json
```

For a recognized source with a separately reviewed valid case, **each**
inspection must report `status: "explicit_approval_required"`,
`readyForApproval: true`, `formalCaseSchemaValidated: true`, and empty
`reviewGaps`. Copy the **64-character `approvalToken` for that exact case**
from its own output. The positive and expected-red tokens must differ.
The CLI uses the runner's actual declarative schema validator locally, then
checks the scanner's observed calls and inputs against the proposed case.
No emulator behavior has been established by these approvals.

A draft with incomplete steps, unsupported fields, missing assertions,
unknown SDK patterns, or `REVIEW_ME` markers is **not approved** and has
`approvalToken: null`. **Only after** the source and completed case pass
static/schema review does the report contain an approval token bound to the
raw SHA-256 hashes of **both selected files**. A token is not authentication
or source-safety evidence; it prevents stale or accidental runs.

## 4. Run the test *only after personal review*

First, separately inspect Docker readiness. An explicit `build` is optional
**only if a matching signed local image is absent**; it may require a large
download and disk space. Do not launch a build merely to create or review a
draft. No application code runs during preflight or build.

**Bash / POSIX shell**

```sh
node "./bin/aws-emulator-mcp.mjs" preflight --json
# Optional, deliberate action after reviewing disk capacity and image provenance:
node "./bin/aws-emulator-mcp.mjs" build
```

**Windows PowerShell (each command is one line)**

```powershell
node ".\bin\aws-emulator-mcp.mjs" preflight --json
# Optional, deliberate build only if needed:
node ".\bin\aws-emulator-mcp.mjs" build
```

The `app-guide` command **never automatically builds an image**. A valid
approval without a matching cached image stops before executing user code.
After confirming your trusted handler and both completed JSON cases, replace
the placeholders below with the **distinct 64-character tokens** obtained in
Step 3. The `--run` flag is the explicit opt-in for executing your trusted
Python handler, and each command uses a separate disposable emulator lab.

**Bash / POSIX shell — deliberately run positive first, then expected-red**

```sh
node "./bin/aws-emulator-mcp.mjs" app-guide "./my-handler.py" "./my-proof.json" --run --approve "PASTE_POSITIVE_APPROVAL_TOKEN" --json
node "./bin/aws-emulator-mcp.mjs" app-guide "./my-handler.py" "./my-proof.expected-red.json" --run --approve "PASTE_EXPECTED_RED_APPROVAL_TOKEN" --json
```

**Windows PowerShell (single-line commands; no Bash continuation characters)**

```powershell
node ".\bin\aws-emulator-mcp.mjs" app-guide ".\my-handler.py" ".\my-proof.json" --run --approve "PASTE_POSITIVE_APPROVAL_TOKEN" --json
node ".\bin\aws-emulator-mcp.mjs" app-guide ".\my-handler.py" ".\my-proof.expected-red.json" --run --approve "PASTE_EXPECTED_RED_APPROVAL_TOKEN" --json
```

Do not run the expected-red control unless the reviewed positive baseline
passes. When the inverted control runs, **a nonzero exit is expected only
because its named post-state assertion fails** while setup, observed SDK
writes and scoped cleanup succeed. Inspect the evidence; startup failures,
wrong SDK calls and failed cleanup are **not** a successful negative control.
These examples do not auto-extract approval tokens or silently execute a draft.

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
  Relative, POSIX absolute and Windows drive-absolute local paths are allowed;
  Windows UNC/network/device paths and remote URLs are refused at parsing.
  Case must be a separate regular `.json` file up to 48 KiB with bounded
  setup, invocation, checks, cleanup and regression assertion.
- Valid case schema does **not** establish that a given SDK operation exists
  in the emulator or will have production AWS semantics.
- Avoid customer data. Use fresh, disposable synthetic resources only.

[Provide an independent reproducible test or onboarding report](https://github.com/B11-Health/aws-emulator-mcp/issues/26).
