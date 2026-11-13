# AWS Emulator MCP: Docker + npm developer beta

**Goal:** a developer can give an AI coding assistant a disposable, isolated AWS-style lab and see real emulated AWS API calls. This is a local developer workshop, not production AWS.

## Current packaging status

This is the **v0.4.0-beta.2 public GitHub source beta** at a signed-off release tag (pending tag publication after CI). The package is not yet published to the npm registry (the unscoped npm registry name is not published or reserved by this repository yet), and the beta Docker image is built locally, not downloaded from a claimed official image registry.

You need **Node.js 20+ and Docker Desktop/Engine running** (Linux containers; on Windows/macOS, Docker Desktop). No local Python, AWS account, production credentials or AWS CLI is required for this MCP experience.

Install from the public GitHub source while the npm registry release is pending:

```sh
npm install -g "github:B11-Health/aws-emulator-mcp#v0.4.0-beta.2"
aws-emulator-mcp doctor
aws-emulator-mcp demo
aws-emulator-mcp config copilot
```

Or run without a global installation:

```sh
npm exec --yes --package="github:B11-Health/aws-emulator-mcp#v0.4.0-beta.2" -- aws-emulator-mcp demo
```

Use `aws-emulator-mcp config vscode` for a VS Code `.vscode/mcp.json` server entry, or `config copilot` for a native Copilot MCP `mcpServers` entry. The configuration points to the **actual installed executable**, not an npm package that may not exist.

**Verified on a separate EC2 Docker host, 2026-11-13:** the npm-packed tarball installed into a fresh prefix and passed six emulator diagnostics; installing this exact GitHub commit into a second fresh prefix also passed the 12-step order demo with four scoped cleanups. The isolated Docker smoke test passed the 29-tool MCP handshake, SDK-model discovery, local S3 CRUD, and cleanup. This is **Linux test evidence**, not a Windows/macOS first-use endorsement.

## What the CLI actually does

1. Verify the Docker daemon is local (Unix socket or Windows named pipe). Remote Docker TCP/SSH contexts are refused.
2. Build a Docker image locally on first use. The rootless image build downloads the **official AWS Emulator Debian package**, verifies the publisher's pinned signing-key fingerprint and detached signature, and installs it.
3. Start AWS Emulator bound to `127.0.0.1:9297` **inside** the container, with anonymous telemetry explicitly disabled.
4. Verify the locally generated CA, emulator-issued credentials, HTTPS health, and isolated STS account.
5. Launch MCP over standard input/output or run a synthetic order demo. When the container exits, its temporary resources and credentials disappear.

Every runtime container is `--network none`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 256`, `--memory 2g`. The launcher publishes **no ports**, mounts **no host paths**, and forwards **no AWS environment variables or credentials**.

The official Linux emulator binary is approximately **994 MB unpacked** for the tested v1.0.338 AMD64 package, so the image is currently larger than 1 GB. The npm package is small and does not contain the binary. The initial build downloads the upstream signed package; subsequent CLI runs reuse the cached image.

## 27 curated MCP tools plus SDK model bridge

The 27 curated tools give simple, explicit operations for S3 text objects, DynamoDB id/message records, standard SQS messages, diagnostics, and verified order/self-test workflows. They remain available from the dependency-free native Python adapter.

The **isolated Docker bundle adds two tools**:

- `aws_sdk_discover`: introspect locally installed botocore service and operation models, including required operation inputs.
- `aws_sdk_invoke`: call a specific modeled AWS SDK operation against the **local emulator endpoint only**, with explicit emulator-issued credentials and the generated TLS CA.

The bundled botocore SDK model catalog currently contains hundreds of AWS services. **This is not a claim that the official emulator implements every service or operation.** Unsupported operations may return 501; shape validation and real responses are part of testing. Model discovery and actual emulator fidelity are separate facts. All SDK calls occur inside the network-disabled container.

## Hands-on acceptance test

Run `aws-emulator-mcp demo`. Passing proof includes a DynamoDB order record, an SQS queued/received work item, an S3 receipt intentionally missing and then created/read back, and cleanup of the unique demo resources. The command prints JSON results; **12 steps, 2 expected failure/recovery assertions, 4 cleanup actions** should pass. Runtime and IDs vary.

Use `aws-emulator-mcp mcp` only from an MCP client. Its stdout is reserved for JSON-RPC (no installation logs). `aws-emulator-mcp doctor` verifies readiness; `aws-emulator-mcp catalog` lists the actual installed tools.

**Known boundaries:** the container is intentionally isolated and does not expose its AWS SDK endpoint to the host, so use MCP and `aws_sdk_invoke` for this beta. Direct host AWS CLI/SDK integration needs a separate, explicit opt-in mode with loopback-only port exposure. No real AWS billing or production IAM validation is performed. Amazon's own [Docker guidance](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html) explains the upstream path; This project's bundle is independently maintained and not an official Amazon product.

## Release-quality gates

The npm tarball must install in a fresh prefix and run a real MCP handshake. Clean CI must build the container, perform doctor, synthetic order, SDK discovery and invocation, reject unmodeled calls cleanly, verify scoped cleanup, and confirm zero external network access. Outside-user Windows/macOS onboarding and an external source/installer review remain **unverified** and are required before claiming stable release. The previous promotional video is **not** considered acceptance evidence.
