# Product direction: AWS Emulator MCP as the AI test engineer's workbench

**Product:** AWS Emulator MCP. **Source publisher:** B11-Health GitHub account. Independent of Amazon Web Services and unrelated to any nonprofit's brand.

## The problem worth solving

An AWS emulator alone can answer AWS SDK/CLI requests. An MCP bridge alone exposes functions. Neither automatically gives a developer confidence that an **application workflow** works, that an agent understood a failure, or that test resources were cleaned up. A local-first workbench should reduce the time between an AI agent changing application code and a trustworthy, reproducible integration-test result.

AWS already ships the emulator, an agent skill, isolated instances, and official fidelity reports. LocalStack's MCP server already supports sophisticated features such as chaos injection, deployment tooling and traces (some require its own authenticated ecosystem). We must **not** pretend these ideas are new or that 32 tool names equal AWS service coverage. Our wedge is an open, easy-to-audit, local testing workflow with a clean evidence contract and no real AWS credentials.

## Phase 1: experiments with observed evidence (implemented developer beta)

- `aws-emulator-mcp experiments` discovers three bounded, synthetic scenarios without starting Docker.
- `aws-emulator-mcp experiment <id> --json` runs a fresh local Docker lab and emits assertion, expected-error, timing and scoped-cleanup evidence.
- An AI assistant can call `lab_catalog` and `lab_run` through MCP, with no user-supplied scripts or command injection.
- Initial scope: S3 missing receipt, DynamoDB intentional overwrite, and a synthetic S3+DynamoDB+SQS order recovery.

**Not claimed:** application-specific execution, broad chaos injection, automatic code repair, IAM testing, production fidelity, Terraform/CDK deployment or state snapshots.

## Phase 2: your application's cloud test loop (proposed, top priority)

**Prompt:** "This repo has a checkout bug. Inspect its AWS SDK operations, run the local tests against a sandbox, show the failing call, propose a patch, and rerun."

- Opt-in, read-only inventory of the project's AWS SDK usage, dependencies and existing tests. Show what the emulator can and cannot check.
- Explicit workspace-run permission and a separate disposable container for any application-specific test command; no hidden access to host secrets or unrestricted Docker socket mounts.
- Stable JSON evidence capturing the command/test version, observed API result, redacted failure details, assertions and cleanup. Surface failed tests directly to the agent.
- Generate a patch suggestion and only claim recovery when a second test run actually passes.

**Ship gate:** independent user can reproduce a real S3/DynamoDB/SQS application bug and a verified fix from a GitHub repository without cloud credentials.

## Phase 3: cloud regression radar (proposed)

**Prompt:** "AWS Emulator updated. Which of the API behaviors my app relies on changed?"

- Keep versioned, sanitized transcripts of allowed test scenarios and compare their observed outputs across two emulator releases.
- Distinguish *successfully exercised*, *unsupported/501*, *failed* and *untested* operations. An SDK model does not imply support.
- Produce a GitHub Actions check with concise failure reproduction and optional link to upstream AWS fidelity evidence.

**Ship gate:** a seeded deliberate regression is detected, reproducible, and tied to the exact emulator versions and API operations.

## Phase 4: agent chaos arena + teaching labs (proposed)

**Prompt:** "Run my order processor against five failures. Which ones does my agent repair without breaking the invariants?"

- Reviewable, versioned scenario packs with declarative fault/expectation definitions; no arbitrary remote code in pack metadata.
- Timeouts, missing resources, duplicate messages and invalid payloads only where the emulator/API demonstrably supports the test. No false security certifications.
- A transparent scoreboard grading *evidence-backed repairs*, not generative prose or invented test results.
- Beginner path: learn S3, SQS, DynamoDB and their failure modes with no AWS account. Expert path: agent-vs-agent debugging on held-out tests.

**Ship gate:** independent scorers can reproduce pass/fail outcomes across clean environments and versions.

## Phase 5: architecture-to-experiment (proposed)

**Prompt:** "Here is my serverless architecture. Tell me what we can test locally, create a bounded test plan and execute the supported subset."

- Analyze a supplied diagram, Terraform, CDK or SAM project **without executing it by default**.
- Enumerate required APIs, match AWS's published fidelity information, and mark unsupported behavior or risky assumptions.
- Generate a declarative sandbox test plan for user review; execute only supported cases with explicit permission, then emit evidence.

**Ship gate:** a held-out sample project receives a correct, reviewable coverage matrix and at least one reproducible passing test without touching real AWS.

## Metrics that matter

- **Time to first passing local experiment**, cold and warm (distribution matters more than a screenshot).
- **Independent Windows, macOS and Linux installation success**, including exact prerequisites and Docker cache behavior.
- **Percentage of run reports with assertions and verified cleanup**, including partial failures.
- **Application-level bugs reproduced/fixed with before-and-after evidence**; measured on held-out public sample apps.
- **Real observed API coverage by emulator version**, never inferred from botocore's modeled-service count.
- **Maintainer burden per contribution**: predictable tests, reviewed scope, and no silent credential/network regressions.

**Principle:** Prefer one impressive, reproducible application repair over adding 100 ambiguous MCP tools.

## Coverage transparency shipped in beta.4

AWS Emulator MCP now pages through the installed AWS SDK service and operation catalog and can run 20 explicitly bounded, read-only API probes against an isolated emulator. This is deliberately separate from AWS's official fidelity measurements: a modeled operation or a successful List/Describe call is not evidence of a complete service implementation. See [coverage methodology](COVERAGE.md).


## Statefully verified developer labs + bounded regression check (beta.5)

Five additional **real emulator experiments** now exercise SNS-to-SQS delivery (including a scoped queue policy), EC2 VPC/subnet/security-group management, EventBridge event-bus ingestion, SSM Parameter Store, and synthetic Secrets Manager records. All use disposable names and verify cleanup. These are not equivalent to service-wide AWS fidelity or to a generic application debugger.

The CLI now compares two operation-level read-only snapshots and fails on newly broken responses. **Full cloud regression radar remains a roadmap item**: it still needs held-out workflows, broader write/read/delete coverage, cross-version stateful baselines and reproducible application repairs.


## Verified application-debugging reference case (beta.6)

The tool now packages a real, deliberately buggy Python order-intake app:
a duplicate retry emits two SQS messages. Its reviewed reference patch
uses a DynamoDB conditional write; real emulator tests confirm one accepted
order and one SQS event. Both runs independently verify seven cleanup
steps. The source, assertions and patch are agent-inspectable through local
MCP. This is **not yet an arbitrary-repository autonomous fixer**.
See [application debugging](APP_DEBUGGING.md).
