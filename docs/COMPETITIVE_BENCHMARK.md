# Competitive workflow audit — November 18, 2026

**Method:** compared first-party public documentation and inspected this repository's `master` source, README, app-case examples and static Demo Studio. This is a **capability/positioning review**, not an independently operated performance benchmark, cloud-fidelity comparison, endorsement, or usage count. Competitor statements can change; verify source links before quoting externally.

| Developer's actual job | Official AWS Emulator + AWS agent skill | LocalStack MCP server | AWS Emulator MCP (independent adapter) |
| --- | --- | --- | --- |
| Connect SDK/CLI and run a local emulator | Officially documented, no AWS account; agent skill installs/configures and diagnoses setup problems | LocalStack orchestration and setup wizard; all MCP tools require a LocalStack auth token | Local signed-emulator Docker lab, explicit MCP tools; no AWS account or LocalStack token |
| Determine whether a project uses emulated APIs with known fidelity | Official skill inspects project operations and maps to published fidelity evidence; **preferred** | Offers LocalStack service/support documentation and coverage feedback for its own engine | Static Boto3 inventories, selected local contract probes; **does not replace upstream fidelity analysis** |
| Deploy/test IaC and diagnose cloud-style runtime workflows | Direct SDK/CLI and developer-owned tests | Documented CDK/Terraform/SAM, log, inspector, chaos, state and infrastructure-testing MCP features | Narrow, allowlisted architecture diagrams/review and bounded SDK contracts; no general-purpose IaC deployment |
| Prove a selected trusted Python behavior fix with a **red baseline and independent state assertions** | Developer can write their own direct integration harness; official skill does not need this adapter | Can use its test/infrastructure tooling; not benchmarked against this exact case | `app-case-compare` compares two explicitly selected local `handle(clients, inputs)` revisions against the **same** reviewed JSON case; observes SDK calls, independent checks, case/source hashes and cleanup |
| First useful experience without AWS account and without Docker | AWS CLI/skill setup can connect the native emulator; actual emulation still needs its runtime | LocalStack MCP requires Docker and auth token according to current docs | `node bin/aws-emulator-mcp.mjs try --json` validates seven local architecture artifacts **only**; no API calls or Python application proof |
| Coverage/production security | Official fidelity reports; even the emulator is not a production security substitute | Different engine and licensing/support contract; capabilities not equated with AWS | Upstream AWS Emulator limitations apply: **not** IAM enforcement, security certification, complete AWS service coverage or deployment |

## Decision: what is actually missing for adoption?

The upstream AWS agent skill already resolves most generic “install AWS Emulator for my agent” value. LocalStack's MCP provides substantially broader deployment, logging, observability and chaos features. Claiming our adapter is more complete would be inaccurate.

**The most credible narrower job is “Show me what my application's bug and fix did to local AWS state.”** Existing app-case code and saved evidence demonstrate that for a bounded, trusted Python entrypoint, but it was buried in JSON and long docs. The draft [Application Proof Explorer](proof-explorer.html) makes those two recorded comparisons inspectable as **static, project-maintained evidence**, first via [local preview](PROOF_WORKFLOW.md#preview-the-proof-explorer-before-github-pages-publishes-it). The public page should not be described as deployed before its source is merged and GitHub Pages updates. The [proof recipe](PROOF_WORKFLOW.md) connects an honest no-Docker first success to static source inspection and opt-in Docker application verification.

This is not broad bring-your-own-repository support: the source must fit one selected function ABI, the JSON case must be separately reviewed, the emulator must implement the chosen calls, and developer source is never run over MCP or an untrusted PR event.

## Independent alternatives worth recommending when they fit better

- **Native AWS Emulator + AWS SDK/CLI**: simplest for a developer already able to write integration tests; it owns the engine and fidelity data. [Official project](https://github.com/aws/aws-emulator), [agent skill](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-agent.html), [project compatibility/fidelity guidance](https://docs.aws.amazon.com/emulator/latest/userguide/check-project.html).
- **LocalStack MCP**: stronger documented scope for IaC deployment, logs, snapshots, chaos and guided setup, with authentication/token and its own emulator/license choices. [MCP repository](https://github.com/localstack/localstack-mcp-server), [installation](https://docs.localstack.cloud/aws/developer-tools/running-localstack/mcp-server/).
- **Moto**: in-process Python AWS mocking for focused Boto3 tests; do not equate it with AWS fidelity. [Getting started](https://docs.getmoto.org/en/latest/docs/getting_started.html).
- **Testcontainers**: standard ephemeral dependency test tooling, including a LocalStack module. [Testcontainers LocalStack module](https://testcontainers.com/modules/localstack/).

## Proposed measurable adoption experiments — not yet run

1. **Unassisted first proof:** recruit consenting independent developers who have never installed this repository. Define denominator as all starts, including failures/abandonments. Record OS, Node version, elapsed time and whether `try --json` exits zero with seven artifacts, no Docker or cloud calls. **Proposed target:** at least 8/10 complete the offline step unaided; not an observed result.
2. **Useful own-app proof:** recruit consenting developers with a *trusted, small Python handler* already owned by them. Record how many understand the ABI and can author a reviewed independent invariant after static inspection; separately report the fraction that get a meaningful expected-red/green result with cleanup. **Proposed target:** 3/5 complete one useful case; distinguish engine limitations from docs gaps.
3. **Incremental value test:** ask each participant whether they would prefer (a) native official skill/SDK tests, (b) LocalStack MCP, (c) this adapter, or (d) none for the exact problem. Capture which specific evidence changed a decision; count negative answers and abandoned attempts. **No inferred adoption from stars or internal CI.**

Never publish participant code, contact third parties, or announce an endorsement without authorization. The [field report form](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml) accepts voluntary, redacted feedback.

## Non-overlapping engineering backlog

- **Agent A:** bounded trusted application runner coverage/invariants, without any new source execution over MCP.
- **Agent B:** adversarial evidence/cleanup/hash negative tests and fail-closed assertions.
- **Agent C:** independent Docker/client install reliability, prerequisites and diagnostics.
- **Agent D:** product claims, public case gallery, copyable examples, the static proof walkthrough, ethical opt-in feedback and measurable adoption experiments.

No cross-team result or endorsement is implied by this matrix. [Recorded scope and test details](APP_CASE.md).
