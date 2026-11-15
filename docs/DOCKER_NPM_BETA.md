# AWS Emulator MCP: Docker + npm developer beta

**Goal:** a developer can give an AI coding assistant a disposable, isolated AWS-style lab and see real emulated AWS API calls. This is a local developer workshop, not production AWS.

## Current packaging status

This is the **v0.4.0-beta.12 GitHub-source candidate**; use a published and
tested Git tag or exact commit for reproducible deployments. The package is not yet published to the npm registry (the unscoped npm registry name is not published or reserved by this repository yet), and the beta Docker image is built locally, not downloaded from a claimed official image registry.

You need **Node.js 20+ and Docker Desktop/Engine running** (Linux containers; on Windows/macOS, Docker Desktop). No local Python, AWS account, production credentials or AWS CLI is required for this MCP experience.

Install from the public GitHub source while the npm registry release is pending:

```sh
npm install -g "github:B11-Health/aws-emulator-mcp#master"
aws-emulator-mcp doctor
aws-emulator-mcp demo
aws-emulator-mcp config copilot
```

Or run without a global installation:

```sh
npm exec --yes --package="github:B11-Health/aws-emulator-mcp#master" -- aws-emulator-mcp demo
```

Use `aws-emulator-mcp config vscode` for a VS Code `.vscode/mcp.json` server entry, or `config copilot` for a native Copilot MCP `mcpServers` entry. The configuration points to the **actual installed executable**, not an npm package that may not exist.

**Verified on a separate EC2 Docker host, November 14, 2026:** a freshly
packed beta.8 tarball installed into a separate npm prefix and passed the full
Docker acceptance suite against signed AWS Emulator v1.0.385. Checks included
the 38-tool MCP handshake, 20/20 selected read-only SDK operations, three
replayable contracts, application bug/fix, all eight bundled experiments,
and Failure Lab's controlled missing-event and lost-acknowledgement scenarios
with 21/21 cleanup checks. These are **Linux test results**, not an independent
Windows/macOS first-use endorsement or full AWS parity.

## What the CLI actually does

1. Verify the Docker daemon is local (Unix socket or Windows named pipe). Remote Docker TCP/SSH contexts and nonlocal `DOCKER_HOST` overrides are refused.
2. Build a Docker image locally on first use. The rootless image build downloads the **official AWS Emulator Debian package**, verifies the publisher's pinned signing-key fingerprint and detached signature, and installs it.
3. Start AWS Emulator bound to `127.0.0.1:9297` **inside** the container, with anonymous telemetry explicitly disabled.
4. Verify the locally generated CA, emulator-issued credentials, HTTPS health, and isolated STS account.
5. Launch MCP over standard input/output or run a synthetic order demo. When the container exits, its temporary resources and credentials disappear.

Every runtime container is `--network none`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 256`, `--memory 2g`. The launcher publishes **no ports**, mounts **no host paths**, and forwards **no AWS environment variables or credentials**.

The official Linux emulator binary is approximately **994 MB unpacked** for the tested v1.0.338 AMD64 package, so the image is currently larger than 1 GB. The npm package is small and does not contain the binary. The initial build downloads the upstream signed package; subsequent CLI runs reuse the cached image.

## 29 curated MCP tools plus Docker-only SDK, debugging and reliability workflows

The 29 curated tools give simple, explicit operations for S3 text objects, DynamoDB id/message records, standard SQS messages, diagnostics, and verified order/self-test workflows. They remain available from the dependency-free native Python adapter.

The **isolated Docker bundle adds three SDK tools, two packaged app-debug tools, two contract tools and two Failure Lab tools (38 total)**:

- `aws_sdk_discover`: introspect locally installed botocore service and operation models, including required operation inputs.
- `aws_sdk_invoke`: call a specific modeled AWS SDK operation against the **local emulator endpoint only**, with explicit emulator-issued credentials and the generated TLS CA.
- `aws_sdk_coverage`: run a **fixed list of 20 read-only operations** with per-service observed statuses. This measures only those operations, not complete service/API parity.

`aws_sdk_discover` now accepts `service`, `query`, `offset`, and `limit`; it can page through all 436 service models and each service's modeled operations instead of truncating the list. Use `aws-emulator-mcp coverage [service] [--json]` to measure selected read-only API calls. See [the measured coverage report](COVERAGE.md).

The tested botocore 1.44.2 SDK catalog contains **436 modeled AWS services**. **This is not a claim that the official emulator implements every service or operation.** Unsupported operations may return 501; shape validation and real responses are part of testing. Model discovery and actual emulator fidelity are separate facts. All SDK calls occur inside the network-disabled container.

## Reproducible experiment missions (new)

```sh
aws-emulator-mcp experiments
aws-emulator-mcp experiment s3-recovery
aws-emulator-mcp experiment dynamodb-overwrite --json > experiment-evidence.json
aws-emulator-mcp experiment order-recovery
```

`experiments` reads the bundled catalog without running Docker. Each `experiment` starts a fresh network-isolated Docker lab, calls actual local emulator APIs, verifies expected responses, and validates scoped cleanup. The MCP tools are `lab_catalog` and `lab_run`. These are fixed, audited synthetic scenarios, not arbitrary user-provided code. See [the lab guide](EXPERIMENT_LABS.md).

## Repeatable reliability experiments (beta.8)

```bash
aws-emulator-mcp failure-lab compare
aws-emulator-mcp failure-lab compare --json > failure-evidence.json
```

The Docker MCP adds `failure_lab_catalog` and `failure_lab_run`. The reviewed
test demonstrates a retry-induced missing event, a pending-state recovery,
and why an idempotent consumer matters after an acknowledgement is lost.
One synthetic RequestTimeout is injected at the SDK boundary; other API
operations run against the actual local emulator. [Understand the evidence
and limitations](FAILURE_LAB.md).

## Hands-on acceptance test

Run `aws-emulator-mcp demo`. Passing proof includes a DynamoDB order record, an SQS queued/received work item, an S3 receipt intentionally missing and then created/read back, and cleanup of the unique demo resources. The command prints JSON results; **12 steps, 2 expected failure/recovery assertions, 4 cleanup actions** should pass. Runtime and IDs vary.

Use `aws-emulator-mcp mcp` only from an MCP client. Its stdout is reserved for JSON-RPC (no installation logs). `aws-emulator-mcp doctor` verifies readiness; `aws-emulator-mcp catalog` lists the actual installed tools.

**Known boundaries:** the container is intentionally isolated and does not expose its AWS SDK endpoint to the host, so use MCP and `aws_sdk_invoke` for this beta. Direct host AWS CLI/SDK integration needs a separate, explicit opt-in mode with loopback-only port exposure. No real AWS billing or production IAM validation is performed. Amazon's own [Docker guidance](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html) explains the upstream path; This project's bundle is independently maintained and not an official Amazon product.

## Release-quality gates

The npm tarball must install in a fresh prefix and run a real MCP handshake. Clean CI must build the container, perform doctor, synthetic order, SDK discovery and invocation, reject unmodeled calls cleanly, verify scoped cleanup, and confirm zero external network access. Outside-user Windows/macOS onboarding and an external source/installer review remain **unverified** and are required before claiming stable release. The previous promotional video is **not** considered acceptance evidence.

**Version notation:** The Node/npm beta uses semver `0.4.0-beta.12`; the embedded Python wheel and MCP server report the PEP 440 equivalent `0.4.0b12`. The v0.3.0 Windows source installer remains a separate compatibility path.

## Versioned regression gate (beta.5)

A successful list/describe call is not full service implementation. To find **new failures in the selected 20 read-only probes** after an emulator update, save two reports and compare:

~~~bash
aws-emulator-mcp coverage --json > current.json
aws-emulator-mcp coverage-diff path/to/baseline.json current.json --json
~~~

The comparator checks the exact service+operation set; it refuses incomparable snapshots, flags status degradation, and does not execute either JSON file. CI compares each current probe result to the recorded v1.0.343 smoke baseline. [Coverage methodology](COVERAGE.md).


## Application-level debugging proof (beta.6)

The Docker bundle includes a real Python order-intake application, its
intentional duplicate-publish bug, a reviewed conditional-write patch,
and a runner that independently verifies the before/after behavior with
fresh DynamoDB, S3 and SQS resources. `app-debug compare` exits
nonzero when the expected failure is not reproduced, the fixed app fails,
or cleanup fails. Local MCP tools `app_debug_catalog` and
`app_debug_run` expose the challenge and evidence; no arbitrary
host-source mounts or remote code execution are enabled.
See the [application debugging guide](APP_DEBUGGING.md).


## Beta.9: agent-authored fault contracts

`contract_guide` now supplies two runnable SQS fault examples. A developer's
coding agent can create a bounded JSON contract for a supported SDK workflow,
then call `contract_run` or run `aws-emulator-mcp contract fault-demo`.
The runner injects at most one synthetic `RequestTimeout`, before a supported
write or after that write successfully returned from the local emulator.
Only `sqs.SendMessage`, `s3.PutObject` and `dynamodb.PutItem` are currently
eligible. Evidence distinguishes injected timeouts from genuine API failures.
This does not execute developer application source or simulate a real outage.
[Details](CONTRACT_TESTING.md).


The current version of this source release is
`v0.4.0-beta.12`. [Peer review and first-run feedback](COMMUNITY_REVIEW.md)
are welcome from AWS builders and coding-agent developers.

## Beta.10: run the contracts in a pull request

The [PR contract gate](CI_CONTRACT_GATE.md) is a GitHub composite action
plus a local `aws-emulator-mcp gate` command. Both scan a bounded flat
folder of JSON contracts, run them in separate isolated Docker emulators,
and record sanitized step-level evidence. GitHub automatically displays a
summary and a downloadable seven-day artifact, and marks the job failed
if any assertion fails. It uses `pull_request` and read-only repository
permissions, without AWS credentials or branch-protection changes.


## Beta.11: offline architecture blueprints

`aws-emulator-mcp architecture demo` generates deterministic CloudFormation
YAML/JSON, SVG, editable draw.io, a synthetic 14-step AWS SDK contract and
source hashes for an S3/DynamoDB/SQS blueprint. Generation is pure local Node
without Docker, AWS credentials or cloud mutations. The diagrams' actor and
arrows are conceptual; only the three physical resources appear in the
template. Independent CI lints the reference template with cfn-lint 1.46.0
and validates the generated contract against the signed isolated emulator.
[Architecture Studio guide](ARCHITECTURE_STUDIO.md).


## Beta.12: architecture change review in GitHub

A second read-only GitHub composite Action, described in
[Architecture Review](ARCHITECTURE_REVIEW.md), compares checked-in JSON
blueprints in pull requests and uploads a before/after visual report.
It requires Node.js only, not Docker or AWS credentials. The review is
not an AWS change-set prediction. It flags certain risky design changes
for a human but cannot determine an actual resource replacement without
a separately approved AWS change set.
