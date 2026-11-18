# Help and support

**AWS Emulator MCP is a community-maintained, independent adapter, not an
official AWS integration.** Choose the smallest supported route for your
question. We don't need AWS account credentials or private customer data.

| You need | Best starting point |
| --- | --- |
| A zero-Docker first run | [Demo Studio](https://b11-health.github.io/aws-emulator-mcp/) and [onboarding](docs/ONBOARDING.md) |
| VS Code Copilot / Claude Desktop setup | [Desktop install guide](docs/DESKTOP_INSTALL.md) |
| IAM, emulation fidelity, requirements or alternatives | [Practical FAQ](https://b11-health.github.io/aws-emulator-mcp/#faq) |
| A reproducible install success or failure | [Independent first-run report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=independent_first_run.yml) |
| A bug in this MCP adapter | [Bug report form](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=bug_report.yml) |
| An improvement idea | [Feature request form](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=feature_request.yml) |
| An AWS Emulator *engine* issue, not adapter code | [Upstream AWS Emulator issues](https://github.com/aws/aws-emulator/issues) |
| Helping with code, testing or documentation | [Contributing](CONTRIBUTING.md) and [good first issues](https://github.com/B11-Health/aws-emulator-mcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) |
| A vulnerability in this repository | [Private vulnerability report](https://github.com/B11-Health/aws-emulator-mcp/security/advisories) and [security policy](SECURITY.md) |

## What to include in a public issue

Use a synthetic, minimal reproduction. Share the **exact version**, operating
system/client, command, expected result, actual result and any sanitized error.
A configuration file alone does not prove that an MCP client successfully
connected or called an emulator-backed tool. Label offline-only results and
uncached Docker image builds accurately.

**Remove** API keys, GitHub tokens, AWS account identifiers, private endpoint
URLs, names or paths from your workstation, proprietary code, and customer
information before posting. Do not paste raw logs without inspection.

## Response expectations

This is a volunteer-scale open-source project. We cannot guarantee response
times, one-on-one setup support, production AWS fidelity or review of arbitrary
external code. You can help by making the issue small, reproducible and linked
to a specific failing test or documentation step.

For interpersonal concerns, see our [Code of Conduct](CODE_OF_CONDUCT.md).
Do not report harassment or other personal information through the software
vulnerability channel.
