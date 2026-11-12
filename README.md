# AWS Emulator MCP v0.3.0

**Let your AI agent test AWS workflows locally, diagnose failures, and show the evidence before deployment.**

Independent MIT-licensed MCP bridge for the official [AWS Emulator](https://github.com/aws/aws-emulator). GitHub publisher: **B11-Health**. LinkedIn announcement: [Code Gym](https://www.linkedin.com/company/codegympr/). Not affiliated with or endorsed by AWS.

## Quickest install on Windows

Requirements: Windows with Ubuntu WSL2 already configured, and internet access for the first AWS Emulator download. No Docker or real AWS credentials needed. If WSL is missing, install it using an elevated terminal:

    wsl --install -d Ubuntu

Extract the release ZIP, then **double-click install.cmd**. The installer:

1. Copies the MCP project to a stable per-user folder under %LOCALAPPDATA%\CodeGym\AWS-Emulator-MCP\v0.3.0
2. Reuses a valid local emulator or downloads and verifies the AWS-signed Linux package
3. Starts or checks local HTTPS and generated emulator-only credentials
4. Performs STS/S3/DynamoDB/SQS diagnostics, test resources, and scoped cleanup
5. Runs an independent legacy + modern MCP protocol smoke test and creates client JSON configs

The installed project stays usable after the Downloads folder or ZIP is removed. The installer **never silently edits an existing MCP client configuration**. First-time installation requires downloading the sizable official emulator package, so speed depends on the network.

The generated files are:
- generated/mcp-client.windows-wsl.json â€” desktop MCP client
- generated/vscode-mcp.windows-wsl.json â€” VS Code

**Double-click demo.cmd** to run a full synthetic order scenario and inspect its report.

## Linux quickstart

Supported and tested path: Debian/Ubuntu on amd64 or arm64, Python 3.10+, curl, GPG, and dpkg-deb. From the extracted project:

    bash install.sh

This uses a rootless, AWS-signature-verified emulator installation. It prints the generated Linux MCP client configuration. For the order demo:

    bash scripts/order_demo_linux.sh

Official macOS setup relies on Docker. We have not verified a macOS one-click installer in this release.

## A real end-to-end order workflow

The MCP tool **emulator_order_demo** creates a fresh synthetic order and unique local resources. It stores the order in DynamoDB, enqueues its ID in SQS, initially fails to fetch a missing S3 receipt, repairs that by writing the receipt, validates the record and receipt, acknowledges the queue message, and removes only the resources it created. It reports steps, timings, assertions, recovery, and cleanup. This is an isolated synthetic test, not a claim that Lambda or EventBridge automatically executed.

The **emulator_self_test** tool provides a shorter STS/S3/DynamoDB/SQS check with cleanup. The **emulator_doctor** tool checks the executable, credentials, CA, local HTTPS endpoint, and emulated STS identity, giving actionable fixes.

## 27 MCP tools

| Category | Tools |
| --- | --- |
| Runtime (5) | emulator_status, emulator_start, emulator_stop, emulator_health, emulator_doctor |
| Identity (1) | emulator_identity |
| S3 (7) | s3_create_bucket, s3_list_buckets, s3_list_objects, s3_put_object, s3_get_object, s3_delete_object, s3_delete_bucket |
| DynamoDB (6) | dynamodb_create_table, dynamodb_list_tables, dynamodb_describe_table, dynamodb_put_item, dynamodb_get_item, dynamodb_delete_table |
| SQS (6) | sqs_create_queue, sqs_list_queues, sqs_send_message, sqs_receive_messages, sqs_delete_message, sqs_delete_queue |
| Workflows (2) | emulator_self_test, emulator_order_demo |

All tools target the fixed localhost emulator. The Python adapter uses only Python standard-library runtime dependencies. S3 supports UTF-8 text; DynamoDB supports a simple id/message string schema; SQS supports standard queues and text messages.

## Connect to a compatible MCP client

Use the generated JSON from the installer. Recommended default transport is **stdio** with no listener. An opt-in bearer-protected HTTP transport is included but binds to loopback only. **Do not publicly forward the local HTTP port.** ChatGPT web cannot directly connect to a localhost/WSL MCP server; a separately reviewed remote connector is necessary.

Supported protocol eras: MCP 2025-03-26, 2025-06-18, 2025-11-25 and stateless 2026-07-28. Modern ping was removed from the protocol and is correctly rejected. More advanced extensions, streaming, and full AWS API fidelity are not claimed.

## Independent official SDK interoperability

The release pipeline runs both **official MCP SDK clients** against the real server process, not just synthetic fixtures:

- Python SDK v2.3.0: legacy 2025-11-25 and modern 2026-07-28 negotiation, tools/list, and a local read-only tool call.
- TypeScript SDK v2.4.0: legacy and modern negotiation, 27-tool discovery, and a local read-only tool call.

These are **test-only dependencies** under tests/external_clients. The MCP adapter itself remains standard-library Python. Both test clients run without an emulator or AWS keys for protocol verification.

## Tests and independent verification

Run the complete local tests:

    python3 -m unittest discover -s tests -v

Run the independent Astra-kit legacy + modern stdio checker:

    python3 scripts/mcp_launch_check.py --out reports/mcp_launch_check.json --min-tools 27 -- python3 -u src/aws_emulator_mcp/server.py

Run the live AWS Emulator integration suite:

    python3 scripts/live_test.py

When executing from an uninstalled source tree, set PYTHONPATH=src or use the supplied install/demo scripts. The CLI entry point for packaged installs is **aws-emulator-mcp-cli**, with doctor, catalog, self-test, and order-demo actions.

The protocol checker and its 29 synthetic-fixture tests were adapted from the GPT-6 Astra launch kit. The checker previously expected ping on MCP 2026-07-28, which the protocol removed. We fixed the **checker** rather than weakening the server. The unit suite, smoke checker, and live emulator test must all pass before publishing; see RELEASE_QA.md for exact evidence and remaining gates.

## Local-only security boundaries

- HTTPS endpoint fixed to 127.0.0.1; TLS verifies the emulator-generated CA.
- Only emulator-generated credentials; never uses your production AWS profile.
- Redirects denied and outbound proxy settings ignored for emulator API calls.
- Explicit schemas, bounded inputs, read-only and destructive tool annotations.
- No public HTTP listener by default; optional HTTP requires a long bearer token.
- Demo and self-test only delete unique resources minted in the current run.

AWS Emulator does not enforce production IAM or resource policies. It has partial API fidelity and in-memory state. Successful emulator tests cannot replace cloud integration or production security testing. Read SECURITY.md and the [AWS Emulator docs](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started.html).

## Publication status

Public source is intended for **B11-Health on GitHub**, with the announcement from **Code Gym on LinkedIn**. A public repository URL, signed release archive, and independent clean install still need verification before announcement. Do not treat the README as evidence that a public release already exists.

## Measurable release benchmark

Run the local engineering gates (Python on Windows automatically routes to WSL):

    python scripts/gtm_benchmark.py --repetitions 5

This measures unit/security tests, independent MCP protocol compatibility, S3/DynamoDB/SQS/STS workflows, p95 order latency, scoped cleanup, and leaked resource inventory. Reports are written under reports/gtm_latest.json. A local pass is **not** public release approval. Independent cold installation, external client compatibility, public CI, security review and final Code Gym demo are separate gates in docs/RELEASE_GATES.md. See docs/COMPETITIVE_BENCHMARK.md for honest positioning against the official agent skill and LocalStack MCP.
