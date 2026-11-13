# Competitive benchmark — AWS Emulator MCP

Verified from public documentation on November 12, 2026. Capabilities below are documented features, not independent comparative performance tests.

| Differentiator | AWS official emulator agent skill | LocalStack MCP | AWS Emulator MCP v0.3 |
| --- | --- | --- | --- |
| Target | Official AWS Emulator | LocalStack engine | Official AWS Emulator |
| Agent setup | Installs and configures AWS Emulator | Interactive npx wizard | Windows/WSL installer and Linux command |
| Account/token prerequisites | No AWS account | LocalStack auth token documented | No AWS account or token |
| Local runtime | Linux native or Docker | Docker/Node and LocalStack | Windows WSL2 native Linux; no Docker on tested setup |
| Agent tool interface | Skill-guided use of AWS SDK/CLI | MCP tools and prompts | 27 explicit MCP tools, stdio/optional local HTTP |
| Multi-service scenario | Depends on agent implementation | Infrastructure validation flows | Deterministic S3 + DynamoDB + SQS order flow |
| Observability | Emulator fidelity reports | Logs, App Inspector and traces | Check-level durations and machine-readable evidence only |
| Fault injection | Not claimed by official skill | Documented chaos tools | Controlled missing-receipt recovery only |
| Repeatable benchmark | AWS maintains its fidelity suite | MCP test harness | 127 local tests (2 expected skips) on Windows and WSL, plus strict GTM scorecard |
| Source/public release | AWS public source | Public repository and npm package | Local release candidate; private staging until gated |

**Current weakness:** LocalStack's documented MCP offering has far broader deployment, tracing, chaos, and client-setup capabilities. AWS Emulator MCP is **not yet** a full IaC/observability platform. We should not claim that it surpasses LocalStack on capability today.

**Positioning:** A conversational AWS-style local laboratory: explicit S3/DynamoDB/SQS operations, repeatable experiments, fail-closed local credentials and scoped cleanup. AWS supplies the emulation engine; this MCP supplies a discoverable AI tool interface.

## Required next improvements

1. Validate a complete first-run install on an independent Windows/WSL computer, not only clean CI.
2. Validate the actual interactive desktop host experience in addition to official Python and TypeScript SDK tests.
3. Add honest service-fidelity coverage and output where APIs differ from AWS.
4. Provide a real, captioned demo recorded from the exact released commit.
5. Make installation errors actionable, and measure first successful tool call on a fresh host.
6. Only then publish the GitHub repo and announce through the product channel.

Sources:
- https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-agent.html
- https://github.com/localstack/localstack-mcp-server
- https://docs.localstack.cloud/aws/developer-tools/running-localstack/mcp-server/
- https://github.com/aws/aws-emulator


## Broad SDK discovery and measured probes (beta.4)

The local Docker bridge now supports paged botocore model discovery and a read-only 20-operation coverage audit across more than three AWS services. This does not replicate the official AWS agent skill's upstream fidelity analysis or LocalStack MCP's deployment and chaos features. See [the snapshot and limitations](COVERAGE.md).
