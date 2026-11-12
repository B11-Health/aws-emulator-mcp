# Competitive benchmark — AWS Emulator MCP

Verified from public documentation on November 12, 2026. Capabilities below are documented features, not independent comparative performance tests.

| Differentiator | AWS official emulator agent skill | LocalStack MCP | B11-Health / Code Gym MCP v0.3 |
| --- | --- | --- | --- |
| Target | Official AWS Emulator | LocalStack engine | Official AWS Emulator |
| Agent setup | Installs and configures AWS Emulator | Interactive npx wizard | Windows/WSL installer and Linux command |
| Account/token prerequisites | No AWS account | LocalStack auth token documented | No AWS account or token |
| Local runtime | Linux native or Docker | Docker/Node and LocalStack | Windows WSL2 native Linux; no Docker on tested setup |
| Agent tool interface | Skill-guided use of AWS SDK/CLI | MCP tools and prompts | 27 explicit MCP tools, stdio/optional local HTTP |
| Multi-service scenario | Depends on agent implementation | Infrastructure validation flows | Deterministic S3 + DynamoDB + SQS order flow |
| Observability | Emulator fidelity reports | Logs, App Inspector and traces | Check-level durations and machine-readable evidence only |
| Fault injection | Not claimed by official skill | Documented chaos tools | Controlled missing-receipt recovery only |
| Repeatable benchmark | AWS maintains its fidelity suite | MCP test harness | Local 90-test suite and strict GTM scorecard |
| Source/public release | AWS public source | Public repository and npm package | Local release candidate; private staging until gated |

**Current weakness:** LocalStack's documented MCP offering has far broader deployment, tracing, chaos, and client-setup capabilities. Code Gym is **not yet** a full IaC/observability platform. We should not claim that it surpasses LocalStack on capability today.

**Positioning:** A small, fast, independent adapter for AWS's actual open-source emulator that prioritizes fail-closed local credentials, evidence-backed QA, isolated resource cleanup and reproducible agent workflows.

## Required next improvements

1. Validate clean install from private staging CI against the newest signed AWS Emulator release.
2. Test at least two real MCP clients, not just our independent checker.
3. Add honest service-fidelity coverage and output where APIs differ from AWS.
4. Provide a real, captioned demo recorded from the exact released commit.
5. Make installation errors actionable, and measure first successful tool call on a fresh host.
6. Only then publish the GitHub repo and announce from Code Gym LinkedIn.

Sources:
- https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-agent.html
- https://github.com/localstack/localstack-mcp-server
- https://docs.localstack.cloud/aws/developer-tools/running-localstack/mcp-server/
- https://github.com/aws/aws-emulator
