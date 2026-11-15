# AWS Emulator contract checks on every pull request

Your coding agent can write a JSON contract for an AWS SDK workflow. This
GitHub Action tests that contract against an **isolated, local AWS Emulator**
every time a pull request changes your code, then adds pass/fail assertions to
the job summary and attaches a sanitized JSON evidence artifact.

No AWS account, AWS access keys, custom runner, paid cloud resources, or
third-party code execution framework is required.

## Add a GitHub Action to your repository

Create `.github/workflows/aws-emulator-contracts.yml`:

```yaml
name: AWS Emulator contract checks

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  aws-contracts:
    name: AWS Emulator / replayable API contracts
    runs-on: ubuntu-24.04
    timeout-minutes: 28
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - uses: B11-Health/aws-emulator-mcp/.github/actions/contract-gate@v0.4.0-beta.12
        with:
          directory: .aws-emulator/contracts
```

The action's code is versioned with the GitHub source release. You can pin
the action to the exact merged commit SHA rather than its tag for additional
supply-chain control. The action itself pins its setup-node and artifact-upload
dependencies to verified commit SHAs.

Add one or more flat `.json` files under `.aws-emulator/contracts/`. To start:

- [Simple S3 read/write/cleanup test](../examples/ci-contracts/01-s3-roundtrip.json)
- [SQS lost-acknowledgement/retry test](../examples/ci-contracts/02-sqs-lost-ack.json)

Copy either file into your own repository and edit its declarative AWS SDK
steps as needed. You may ask your coding assistant to call `contract_guide` to
generate a contract based on the AWS SDK operations it finds in **your**
repository. The MCP itself does not read or execute your application source.

## Run the same gate locally

Requires Node.js 20+, running local Docker and the GitHub-source package:

```bash
npm install -g "github:B11-Health/aws-emulator-mcp#v0.4.0-beta.12"

aws-emulator-mcp gate .aws-emulator/contracts
```

The command returns a failing exit status if **any** contract fails or the
directory is missing/malformed. Evidence is written to
`reports/aws-emulator-contract-evidence/` in the current workspace.

## What appears on your pull request

The `AWS Emulator / replayable API contracts` check is green when every
contract succeeds. A failed assertion makes the check red. GitHub's Actions
job summary presents a table of tested files, steps passed, and results.

The downloadable **aws-emulator-contract-evidence** workflow artifact contains
`report.json`, `summary.md`, and `case-01.json` (etc.) with:

- Contract file name and plan SHA-256.
- Emulator version and isolated account verification.
- SDK service, operation, step outcome, and sanitized assertion booleans.
- A clear distinction between an injected `synthetic_sdk_timeout` and
  a real emulator API error, including whether the selected write was sent.

The gate never writes raw contract parameters, SDK response bodies, request
payloads, AWS credentials, or child-process stderr to the evidence. The
artifact is retained for seven days.

**To block merges**, make this job a required status check in your
repository's branch protection or ruleset settings. The Action alone creates
the PR check; it does not change your repository's branch protection.

## Safety and predictable CI runtime

- A flat folder of **1-6 regular JSON files**, with at most **48 KiB** and
  **16 AWS SDK operations** per contract. Empty folders, oversized input,
  links, traversal paths, and invalid JSON fail closed.
- The action reads only checked-in JSON data; it does not run the source code
  from the pull request. Its runner is loaded from the pinned action version,
  and the trusted SDK contract validator rejects shell commands or scripts.
- Each plan runs inside a fresh, network-disabled Docker container (no
  published ports or host mounts), using the verified local emulator account
  `000000000000`. No production AWS credentials are forwarded.
- Docker builds an image from the signed official AWS Emulator package on
  first use. The build requires network access on the **host**; the running
  test container has no external network access.
- A synthetic SDK timeout can be injected once per plan only for the explicitly
  supported AWS write operations. It is **not a real AWS outage**.
- The workflow uses `pull_request`, not `pull_request_target`, and requests
  `contents: read` only. It does not post comments, approve PRs, commit code,
  write repository secrets, or deploy.

This CI gate checks **only the declared local AWS API behavior**. It does
not execute your actual application, validate IAM policy fidelity, prove
exactly-once delivery, or replace staging tests against AWS. SDK operations
may be modeled but unimplemented in the emulator; a failure is useful
evidence, not a proof of an AWS production defect.

## Inspect and adapt

- [Reusable composite action source](../.github/actions/contract-gate/action.yml)
- [Bounded runner and evidence formatter](../scripts/contract_pr_gate.mjs)
- [Independent GitHub Actions self-test](../.github/workflows/contract-gate-selftest.yml)
- [Underlying contract format and fault modes](CONTRACT_TESTING.md)


## Visual infrastructure changes, not only API contract assertions

Pair this Docker-backed contract gate with the
[Architecture Review GitHub Action](ARCHITECTURE_REVIEW.md). Architecture
Review compares JSON blueprints, renders before/after SVG and editable
draw.io files, flags potentially destructive changes and uploads a separate
seven-day evidence artifact. It uses Node only and does not access AWS or
run the emulator. The two checks answer different questions: **what is
proposed?** versus **does this supported local SDK sequence pass?**
