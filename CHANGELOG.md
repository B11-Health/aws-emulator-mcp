## v0.4.0-beta.11 — Architecture Studio, offline blueprint compiler (candidate)

- Added a strict typed manifest for a conceptual application actor and up to
  three supported AWS resources: S3 bucket, DynamoDB table and SQS queue.
- `aws-emulator-mcp architecture demo` and
  `architecture build <manifest.json>` generate deterministic CloudFormation
  YAML/JSON, SVG, editable diagrams.net/draw.io, synthetic SDK contract and
  a SHA-256 provenance report, without Docker, AWS credentials or cloud calls.
- Default S3 public-access blocks, encryption and versioning; DynamoDB/SQS
  SSE; retention policies for data-bearing resources. Only physical resources
  are expressed in CloudFormation, not conceptual actor/flow relationships.
- The generated 14-step contract is exercised against isolated signed AWS
  Emulator; DynamoDB CreateTable has a bounded ACTIVE readiness check to
  avoid immediate dependent-write races.
- Independent diagram/template/source consistency tests and cfn-lint checks,
  plus malformed input/secret/path refusal tests. Actual AWS deployment
  and account inventory are intentionally out of scope.

## v0.4.0-beta.10 - pull-request contract checks (source candidate)

- Added a reusable GitHub composite action for automatically replaying 1-6
  bounded AWS SDK JSON contracts on a developer's pull request.
- Job summaries, fail-on-assertion checks, and a seven-day sanitized evidence
  artifact include plan hashes, emulator version, step outcomes and fault
  forwarding status without raw payloads or credentials.
- Added `aws-emulator-mcp gate [directory]` for local parity with the CI
  runner, two reviewed example plans and a copy-paste GitHub Actions workflow.
- The workflow requests read-only contents permissions and uses the pinned
  source action; it does not execute PR source code or add PR comments.
- New independently hosted self-test checks the action and its artifact.
  No npm-registry publication, AWS account usage, or full AWS fidelity claim.

## v0.4.0-beta.9 - agent-authored SDK fault contracts (candidate)

- Extend the existing isolated, declarative contract runner with one bounded
  synthetic SDK-boundary RequestTimeout per plan. Allowed operations are
  SQS SendMessage, S3 PutObject and DynamoDB PutItem; an after-success fault
  only triggers after the actual emulator API returned successfully.
- Two reviewed reusable SQS recovery and lost-acknowledgement templates plus
  `aws-emulator-mcp contract fault-demo`.
- Redacted evidence differentiates injected timeouts from real API errors and
  records whether the write reached the emulator.
- This does not execute user source code, run arbitrary chaos scripts,
  reproduce an actual network outage, or certify AWS compatibility.
- Fixed a Failure Lab import-order issue found during clean-module QA.

## v0.4.0-beta.8 — AWS Failure Lab (source candidate)

- Added a bounded failure/recovery comparison: one synthetic SDK pre-send
  timeout reproduces a missing SQS event; pending-state recovery publishes
  one event; an injected lost acknowledgement produces two genuine SQS
  deliveries but one conditional DynamoDB consumer-effect marker.
- Added two Docker-only MCP tools `failure_lab_catalog` and
  `failure_lab_run`, and `aws-emulator-mcp failure-lab compare`.
- Evidence reports genuine emulator-observed queue counts, durable state,
  synthetic fault details, assertions, and scoped resource cleanup.
- Includes a reviewed recovery application, dedicated documentation, and
  host/unit/MCP/Docker regression tests. Does not claim full AWS fidelity,
  real network outages, production guarantees, or arbitrary app execution.

## v0.4.0-beta.7 — replayable AWS SDK contracts (source candidate)

- Introduced `contract demo|<plan.json>` and Docker MCP tools `contract_guide`
  and `contract_run`: bounded declarative AWS SDK API sequences with fixtures,
  references, explicit assertions, expected errors and redacted evidence.
- MCP contract execution uses a dedicated emulator process, isolated temporary
  HOME/credentials and random loopback port for every request. CLI tests run in
  disposable network-disabled Docker containers, with no host mounts.
- Three replayable examples cover S3 write/read, SQS delivery/acknowledgement and
  EC2 VPC/subnet lifecycles. All passed local integration checks against signed
  AWS Emulator v1.0.385. An intentionally false assertion failed as required.
- Added negative security, schema, packaging, CLI and Docker MCP regression
  gates. This remains a GitHub source beta, not a published npm release or
  production AWS security/fidelity claim.

## v0.4.0-beta.6 — real application debugging case (source candidate)

- Adds a genuine executable Python order-intake sample, an intentionally
  broken version, a reviewed conditional-write fix, and an applicable diff.
- `aws-emulator-mcp app-debug compare` runs each version against
  fresh local DynamoDB, S3 and SQS resources, verifies duplicate event counts,
  and fails if assertions or scoped cleanup fail.
- Docker-only `app_debug_catalog` and `app_debug_run`
  tools expose the source and reproducible verification: 29 native curated
  tools remain unchanged; isolated Docker provides 34 total MCP tools.
- It does **not** execute arbitrary user/agent code or establish crash-atomic
  messaging, production IAM correctness, or broad AWS service fidelity.

## v0.4.0-beta.5 — stateful AWS experiments and versioned regression checks

- Added five synthetic SDK-backed experiments: real SNS-to-SQS message delivery and acknowledgement with explicit queue policy, EC2 VPC/subnet/security-group management, EventBridge bus and event submission, SSM Parameter Store, and Secrets Manager create/read/delete.
- Eight allowlisted experiments total. Each reports observed API assertions and run-scoped cleanup; undelivered messages and cleanup failures fail the run.
- Added a local-only coverage-diff command: compares two signed-emulator read-only probe snapshots, identifies operations that regress, and rejects incomparable or malformed reports. CI now checks against the recorded v1.0.343 baseline.
- Signed AWS Emulator v1.0.353 verified locally: eight labs, 20/20 selected read-only probes and no regressions from v1.0.343. This is not an AWS service-fidelity certification.
- GitHub-source beta only; no npm registry/Docker registry release claimed.

## v0.4.0-beta.4 - verified service discovery and coverage reports

- Add dynamic, paginated AWS SDK service and operation discovery across all modeled services.
- Add bounded read-only SDK coverage probes and a CLI coverage command, with per-operation status and no full AWS API fidelity claim.
- Improve README, documentation and demo visuals to distinguish 29 curated and 3 isolated SDK tools.
- Continue the source-only GitHub beta; neither npm nor Docker registries are published.

## v0.4.0-beta.3 (source beta) - reproducible AWS experiment labs

- Add `aws-emulator-mcp experiments` and `aws-emulator-mcp experiment <id> [--json]` with structured evidence and cleanup, and corresponding `lab_catalog` / `lab_run` MCP tools.
- Introduce fixed synthetic S3 recovery and DynamoDB overwrite labs alongside the existing order recovery demonstration.
- Upgrade curated tool count to 29, plus two optional isolated SDK model tools (31 inside Docker); **tool count is not service coverage**.
- Add cross-platform unit tests, a packaged JSON experiment catalog, and real signed-emulator Docker acceptance checks.

## v0.4.0-beta.2 — product identity cleanup

- Project/tool name and published npm package identity are **AWS Emulator MCP**.
- The npm command is now `aws-emulator-mcp`, and the local Docker image is `aws-emulator-mcp:0.4.0-beta.2`.
- The repository is published through the B11-Health GitHub account; Code Gym is an unrelated nonprofit and is not the product.
- New Windows source installations use `%LOCALAPPDATA%\AWS-Emulator-MCP`; legacy paths remain readable by the demo/connect helpers.
- This beta is source-installable from GitHub; **no npm registry package or public Docker registry image is claimed**.

# Changelog

## Unreleased — developer experience and product story

- README now leads with hands-on AWS Emulator MCP use cases and clear local-vs-AWS value, rather than tool counts and protocol versions.
- Added a use-case playbook for S3, DynamoDB, SQS, the synthetic order flow and troubleshooting.
- Added a reproducible launch-video plan and revised Code Gym LinkedIn draft with accurate feature boundaries.
- Added documentation contract tests for links, install commands, expected workflow evidence and remote read-only scope.
- Validated a fresh order demo (12 steps, 2 recovery checks and 4 cleanups) and the complete 127-test Windows/WSL suite (2 expected skips on each platform).

## 0.3.0 — November 12, 2026 (local release candidate)

### Installation and onboarding
- Windows double-click installer: install.cmd + PowerShell, with an Ubuntu WSL2 quickstart and stable per-user installation location.
- Linux quickstart command: bash install.sh, rootless signed AWS Emulator package installation for amd64/arm64 Debian systems.
- Skips large AWS package download when an existing emulator is usable; verifies local TLS, generated credentials, and isolated STS identity.
- Generates ready-to-copy client and VS Code MCP configs; does not edit existing client settings.
- Windows demo.cmd plus Linux demo script for a real synthetic end-to-end order workflow.

### Application workflows
- New emulator_doctor tool and CLI health diagnostics.
- New emulator_order_demo tool with DynamoDB order, SQS queue, S3 receipt, expected missing-object failure, repair, readback assertions and scoped cleanup.
- 27 total tools; optional authenticated HTTP remains off by default.

### Protocol and security
- Integrated the GPT-6 Astra independent MCP stdio launch checker and its synthetic fixture tests.
- Corrected the kit's modern ping expectation: ping was removed in MCP 2026-07-28.
- Stricter S3 path-component validation; no redirects to external URLs, no real AWS credential use.
- Improved tool metadata and release QA reporting.

### Validation
- 103 unit tests passing on Windows and WSL2.
- Independent launch checker passed legacy and modern protocols.
- Live official AWS Emulator v1.0.322 checks passed for STS, S3, DynamoDB and SQS.
- Warm Windows installer and separate demo both completed successfully.

### Install and runtime safety
- Windows installer preflights managed paths, nested source entries and nested installed content for symlinks and junctions before replacing any files.
- Linux quickstart validates AWS_EMULATOR_PORT and passes it to both detached and systemd startup modes.
- Forces LF checkouts for Bash scripts on Windows so WSL launchers cannot break from CRLF conversion.
- Adds a weekly signed-emulator compatibility CI run (no automatic release).
- Dedicated Windows junction fixture ensures unrelated files remain untouched when a malicious redirect is encountered.

### Native client onboarding
- Generates native VS Code Copilot mcpServers format alongside the legacy editor-managed servers format.
- Adds an opt-in Windows Copilot connector with preview, strict JSON parsing, conflict refusal, backup and idempotence.
- Benchmark captures source commit, emulator version and binary SHA256 for evidence provenance.
- A Code Gym video preview uses a real recorded dashboard rather than fabricated test footage.

### Evidence-first release hardening
- Strict MCP 2026 Streamable HTTP request header validation; failed order demo returns MCP tool error.
- Official TypeScript v2.4.0 and Python v2.3.0 client interoperability checks, in both protocol eras, including authenticated HTTP for Python.
- Five-run, fail-closed GTM benchmark and dependency-free offline HTML evidence dashboard.
- Source credential heuristic scan, version consistency assertions, and pinned GitHub CI with official signed emulator installation.
- Local benchmark 10/10 scenarios, p95 7.265 seconds, zero leaked demo resources; private GitHub Actions clean Linux run passed on AWS Emulator v1.0.336.

### Private ChatGPT integration, read-only
- Installed private Code Gym AWS Emulator - Secure QA custom plugin in
  ChatGPT Personal without an OpenAI API key, verified real calls twice.
- Dedicated mTLS HTTPS MCP endpoint, local-only gateway, independent private
  proxy edge token, secure outbound Windows WSS relay, two matching allowlists.
- Confirmed ChatGPT itself reached the Windows emulator at 127.0.0.1:9297,
  official version 1.0.322 and 6/6 healthy checks, no production AWS.
- Added reproducible secret-free gateway and Windows agent sources,
  environment templates and optional remote integration QA.

### Pending
- Public GitHub release and independent cold Windows installation verification.
- macOS/Docker quickstart and independent security audit for optional remote connector.

## 0.2.0 — November 12, 2026
- Local STS/S3/DynamoDB/SQS MCP adapter, 25 tools, protocol and HTTP security tests.

## 0.1.0 — November 11, 2026
- Initial local stdio bridge to the official AWS Emulator.
