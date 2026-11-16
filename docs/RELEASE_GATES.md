# Release gates — AWS Emulator MCP

**Identity:** AWS Emulator MCP is the tool; B11-Health is the GitHub publishing account. Independent of AWS.

## Product thesis
AWS already supplies the emulator engine and an official agent skill. Our public promise is **a practical AWS-style playground operated through an AI assistant**: explicit local MCP operations, reproducible examples, measured results and scoped cleanup. Do not market complete AWS coverage or production IAM validation.

## Developer-experience and messaging acceptance

- The first screen states what developers can **do** before listing protocols or tests.
- One prompt reproduces a real S3/DynamoDB/SQS scenario and shows expected failures and cleanup.
- Published examples distinguish working MCP tools from possible future emulator integrations.
- Windows and Linux installation commands work from a **logged-out public GitHub clone**.
- ChatGPT's read-only, three-tool Secure QA plugin is never advertised as the **local 29-curated-tool adapter** or the **32-tool isolated Docker MCP**.
- A live, recorded demonstration shows actual emulated API effects, not invented screenshots.

## Automated engineering gates

| Dimension | Release threshold |
| --- | --- |
| Unit and negative-security tests | 100% passing on Python 3.10 + 3.12, at least 100 cases |
| MCP interop | Legacy 2025-11-25 and modern 2026-07-28 independent checker passes |
| Catalog | At least 29 curated, schema-validated tools; optional isolated Docker SDK bridge is separately scoped and labeled |
| Credential isolation | HTTPS loopback only; only emulator credentials; STS account 000000000000 |
| Scenario reliability | 5/5 self-tests and 5/5 order demos pass, 100% cleanup |
| Performance | Warm order-demo p95 <=12 seconds, warm Windows installation <=30 seconds |
| No leaked test state | Run-created bucket, table and queue absent from final inventory |
| HTTP security | Auth and Origin/Host validation; strict modern MCP header matching |
| Supply chain | Official AWS package signature validated; reproducible wheel + clean commit |
| Client UX | Official Python and TypeScript SDKs work in both eras; native Copilot config and opt-in merge verified in Windows fixture; real desktop UX remains pending |

## Current developer-preview verification (v0.4.0-beta.4)

- [PR #14](https://github.com/B11-Health/aws-emulator-mcp/pull/14) was merged on November 14, 2026 after **all seven required CI gates passed** on the reviewed head.
- The current native curated interface has **29 MCP tools**; isolated Docker adds three general SDK tools for **32 total**.
- The botocore model catalog shows **436 modeled services**, but models are **not proof of implementation**. The independent read-only audit successfully called **20 of 20 selected APIs** on signed AWS Emulator v1.0.343. See [coverage evidence](COVERAGE.md).
- The npm source package uses an exact **26-file allowlist** with no Python bytecode; it has **not** been published to the npm registry.
- The current README demo is a silent, real CLI recording, not the earlier narrated promotional cut.

These are **engineering gates**, not an outside security certification, complete AWS parity, or independent Windows/macOS first-use signoff.

## Mandatory independent release gates

- Fresh Windows/WSL2 installation on an uninvolved host and native Linux installation against the current signed AWS release.
- Continuous integration green on the **public** B11-Health repository, with an accessible tag and license.
- Outside reviewer checks security boundaries, documentation, secret hygiene and cold install.
- A logged-out developer can clone, install and complete the order demo using public instructions only.
- Project demonstration video reflects **the exact shipped commit**, records real execution and clearly states emulator fidelity limits.
- Public link works without login, is not an unrelated website repository, and has source provenance.

**Decision:** The automated scorecard can pass local engineering gates, but cannot by itself approve a public launch. Untested independent gates remain explicit BLOCKED items.

## Go-to-market outcomes after release
Track time-to-first-successful-test, installation completion rate, reproducible issue rate, returning developers and useful contributions. GitHub stars matter, but not as a proxy for actual adoption.

References: https://docs.aws.amazon.com/emulator/ and https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http


## v0.4.0-beta.5 candidate — additional bounded verification

The current source adds five stateful synthetic experiments (SNS/SQS, EC2 network control plane, EventBridge event bus, SSM Parameter Store, and Secrets Manager) and a local coverage snapshot comparator. A valid regression comparison requires identical API probe sets; a drop from a previously successful operation produces a failing exit status. This does **not** verify arbitrary AWS operations, encryption, IAM, event routing, production network behavior or security. Final release approval still requires independent Windows/macOS cold onboarding, a public source tag, and external review.


## v0.4.0-beta.6 application debugging acceptance

GitHub's Docker job must test the **installed npm tarball**, not merely a
working tree. It must observe 2 SQS messages from the deliberately broken
application and exactly 1 from the patched application, verify their
DynamoDB/S3 invariants and 7/7 resource-cleanup checks in each run, check
an actual unified patch, and reject untrusted variant/URL/script arguments.
No claim of production AWS security, crash-atomic messaging or arbitrary
repository support follows from this bounded demo.

## Replayable contract runner validation — feature branch

The Docker MCP adds `contract_guide` and `contract_run` for 36 total tools in beta.7,
and the CLI adds `contract demo|<file>`. Up to 16 declarative AWS SDK calls
can be sequenced with response references, expected API errors and explicit
assertions. MCP contracts get a new emulator process, temporary HOME, random
loopback port, and emulator credentials. No arbitrary scripts, host mounts,
forwarded credentials, or public ports.

The independent source unit tests and signed-emulator acceptance job must
exercise the packed CLI, positive and negative plan assertions, subprocess
isolation, model-operation errors, and protocol-level invalid-argument
rejection before this feature can be considered merged. See
[contract testing](CONTRACT_TESTING.md). This does not authorize npm
publication or imply full emulator compatibility.


## v0.4.0-beta.8 — failure/recovery acceptance

The signed-emulator Docker release gate executes the packed npm CLI's
`failure-lab compare --json`, then the Docker MCP `failure_lab_catalog`
and `failure_lab_run`. Verify:

- A one-shot synthetic timeout *before* sending leaves the existing application
  with 0 SQS events after retry and a prematurely queued DynamoDB state.
- The recoverable version persists pending work, retries and produces exactly
  1 SQS event and 1 conditional DynamoDB consumer-effect marker.
- A simulated lost response *after* real SQS acceptance yields 2 messages but
  1 consumer-effect marker; this is at-least-once delivery, not exactly-once.
- 7/7 uniquely named resource cleanup checks succeed for each run.
- Invalid scenario names/paths/scripts are rejected before source execution.
- Tool descriptions and reports explicitly identify the SDK-boundary fault
  simulation and do not claim actual AWS network faults, arbitrary source
  execution or production reliability guarantees.


## v0.4.0-beta.9 - agent-authored fault contract gates

For every supported fault mode, the signed-emulator Docker job runs a **packed
and freshly installed npm CLI** with an agent-authored JSON contract:

- `before-call` proves a synthetic RequestTimeout was returned without
  forwarding the write, the queue is empty, then the retry yields one event
- `after-success` proves the original emulated SQS SendMessage succeeded
  before its SDK acknowledgement was suppressed; retry yields two separately
  receivable messages, and both are acknowledged and the queue deleted
- The MCP path runs the after-success contract in an independent emulator and
  rejects an untrusted `fault.command` field at the protocol boundary
- Reports differentiate `synthetic_sdk_timeout` from genuine `api_error`
  and record `sentToEmulator` without disclosing request/response content
- The validator allows at most one fault, only on SQS SendMessage, S3 PutObject,
  or DynamoDB PutItem, and requires an explicit expected RequestTimeout
- A direct import of Failure Lab must not cause a circular import

These gates do not execute arbitrary developer code, certify AWS fidelity,
or simulate actual network failures. Passing local QA is insufficient for
merge until the hosted seven-job workflow succeeds on the published PR head.


## v0.4.0-beta.10 - pull-request contract gate

The eighth hosted job runs the actual local composite action as a consumer
repository would: checkout, execute two checked-in plans, upload a seven-day
redacted evidence artifact, and verify its assertions with a separate Python
step. This must pass on the exact reviewed PR head before the candidate merges.

Node unit tests cover 1-6 plan bounds, deterministic selection, symlink and
path-traversal rejection, malformed JSON, oversized payloads, simulated
contract failures, spoofed green exit codes, and redaction of unsafe raw child
output. Windows and Linux unit suites must pass independently.

The action uses only `pull_request` with `contents: read`, SHA-pinned
setup-node and upload-artifact dependencies, and no production AWS account.
It doesn't mutate branch protection or leave PR comments. The CLI and action
share the same runner, so local and hosted behavior are reviewable.


## v0.4.0-beta.11 — Architecture Studio (no AWS access)

The npm package gate must generate the reference architecture offline from
the versioned manifest and verify all seven files against checked-in hashes.
Independent Python stdlib tests cross-check resource IDs, output references,
SVG/XML graph nodes/edges and synthetic contract validation. The job also
installs pinned `cfn-lint==1.46.0`, lints the generated `template.yaml`,
and checks the YAML and JSON templates for semantic equality.

Unit tests reject unsupported AWS resource types, duplicate IDs, undeclared
flows, credential-like values, arbitrary CloudFormation/IAM fragments,
workspace traversal, symlinked inputs/outputs, oversized input and file
overwrites. Deterministic output must contain no timestamps or credentials.

The signed-emulator Docker job executes the freshly installed npm package's
generated 14-step S3/DynamoDB/SQS contract with bounded DynamoDB readiness.
Every step and account verification must pass; no real AWS or CloudFormation
deployment is attempted. PR needs all independent hosted jobs green before
merge or tag publication.


## v0.4.0-beta.12 — GitHub PR architecture review

A new GitHub workflow uses the reusable composite Action the same way a
downstream repository does. It compares two checked-in test manifests,
renders a before/after diagram and individual SVG/draw.io exports,
computes a risk summary and uploads a seven-day evidence artifact.
Independent Python verification checks JSON policy flags, exact node
counts, CloudFormation output and non-execution of any real AWS action.

Unit tests verify added, unchanged, removed, type/key-change and
conceptual-only cases, deterministic results, no-baseline handling,
trusted base commit SHA reads, path and credential-like input refusal,
idempotency, non-overwrite, XML escaping and strict opt-in fail-on-risk.

This is a source-level proposed blueprint comparison, NOT a real AWS
CloudFormation change set. No live account, IAM credentials, Docker, remote
comments, PR write permissions or cloud deployment are used.


## v0.4.0-beta.13 — Marketplace-ready root Action and separate-consumer tests

The repository-root `action.yml` metadata must remain schema-valid,
include a unique name, descriptive purpose and supported branding, and
use a pinned Node runtime and pinned evidence uploader. It must call the
trusted reviewed `scripts/architecture_review.mjs` from the action
checkout, never import arbitrary code from a PR, never require AWS
credentials, and never imply a real CloudFormation change set.

Independent hosted acceptance must invoke both entrypoints: the legacy
nested Action and the root Action, each in its own job with a distinct
artifact name. Validate generated SVG/JSON, upload artifact even when a
policy check fails, and keep no publication secret in the consumer workflow.

A separate project-maintained repository exercises the published Action:
a safe SQS-addition PR passed with 11 verified generated files; a
DynamoDB-key mutation produced an expected code-2 failure while still
uploading all 11 verified artifacts. Neither run claims independent
community adoption or production AWS parity. Root Action Marketplace
listing is a separate publisher-approved step.


## v0.4.0-beta.14 — Genuine user-selected Python handler, CLI-only

The application-acceptance pilot tests a developer's manually selected
Python order handler, not just the bundled order-intake source. The
`app-verify` command must refuse remote URL inputs, symlinks, oversized
or invalid UTF-8 local files before Docker, and must transmit source
through stdin into the no-network/no-host-mount one-shot worker with
verified account `000000000000`. The worker is non-root, bounded by Docker
resource limits and a 150-second execution deadline.

The pinned sample intentionally publishes twice; the fixed sample writes
a typed synthetic DynamoDB order and exactly one SQS event after retry,
with a matching receipt. Real emulator tests must assert eight functional
invariants, all seven cleanup checks and source SHA-256 integrity. The
remote MCP tool catalog and all PR Actions must **not** accept arbitrary
caller source or code-execution inputs. This is a trusted local
opt-in feature, not hostile-source sandboxing, a general app runner or
AWS fidelity guarantee. README now explicitly treats SDK models and
the 20 historical read-only probe responses as **diagnostic context**.
