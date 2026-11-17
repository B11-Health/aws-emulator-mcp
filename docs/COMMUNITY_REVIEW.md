# Help us test whether AWS Emulator MCP is actually useful

The official [AWS Emulator](https://github.com/aws/aws-emulator) already allows developers and coding agents to test AWS API calls locally. It also has its own agent setup and CI guidance. This independent project adds an MCP interface, isolated experiments, declarative retry/failure contracts and a pull-request gate.

**We're looking for critical technical feedback, not endorsements or star requests.**

[**Submit a developer field report**](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml)

## Three specific reviews that would help

| Review | What to try | What we need to hear |
| :-- | :-- | :-- |
| **First-use experience** | Install from the tagged GitHub source, start Docker and connect your actual AI client | Where did setup fail? How many manual steps felt unnecessary? |
| **Failure behavior** | Run `aws-emulator-mcp contract fault-demo --json`; inspect the injected lost-acknowledgement step | Would this catch bugs in your development process? What is missing or potentially misleading? |
| **Pull-request adoption** | Add the [GitHub Action](CI_CONTRACT_GATE.md) and one synthetic S3 or SQS contract | Is the CI summary actionable? Would you require this check before merging? |

A reviewer can also assess the architecture and documentation **without installing** anything. We particularly welcome an answer to: **When would you use the AWS CLI/SDK or the official emulator's own agent tooling *instead* of this MCP?**

## Honest boundaries

- AWS Emulator is an AWS project; **AWS Emulator MCP is independent**, not official or AWS-endorsed.
- Available SDK API models and emulator fidelity are different measurements. Not every modeled operation works.
- The current Docker adapter exposes 29 curated tools plus 9 Docker-only tools. It does not implement all AWS services.
- The Failure Lab timeout is synthetic and injected at the local SDK boundary, not an AWS outage.
- A passing contract validates the **declared emulated API sequence**, not arbitrary developer application source, IAM fidelity, or production AWS behavior.
- Isolated tests shouldn't receive your AWS credentials or real customer data. Never share such data in a report.

## Fast no-build installation feedback (current source checkout)

On `master` (not the pinned beta.14 tag), run `node bin/aws-emulator-mcp.mjs
preflight --json` from a checkout. It inspects only the local Node/Docker
prerequisites and image cache, without downloading or launching the emulator.
A missing Docker daemon is expected to return exit code 1 while still yielding
machine-readable diagnostics. Your operating system, success/failure, and the
command that blocked you are more useful than a screenshot of a successful
build. Review any output before sharing it, and do not include private paths,
credentials or internal source.

## Minimal reproducible experiment

Requirements: Node.js 20+, running local Docker, and an internet connection for the first signed-emulator image build.

```bash
npm install -g "github:B11-Health/aws-emulator-mcp#v0.4.0-beta.14"
aws-emulator-mcp doctor
aws-emulator-mcp contract fault-demo --json
```

Or [watch the short Failure Lab walkthrough](assets/demos/failure-lab.mp4). It is a recorded browser tour backed by saved emulator evidence, not live cloud execution.

To report something actionable, include the AWS service and operation, your OS/AI client, expected vs observed behavior, a synthetic reproduction and any sanitized assertion results. Use the [field-report form](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml). For a vulnerability, use [private security reporting instructions](../SECURITY.md) rather than a public issue.

## How feedback changes the project

We will distinguish three categories rather than conflating them:

1. **MCP adapter bugs** — our launcher, protocol, validation, UX, or CI evidence. Reproduce and fix here.
2. **Upstream emulator fidelity gaps** — verify against AWS documentation and report to [aws/aws-emulator](https://github.com/aws/aws-emulator/issues) without inventing parity claims.
3. **Product adoption gaps** — shorten setup, prioritize useful operations, improve integrations, or remove unneeded features.

Constructive criticism, failed trials, and “I would not use this because…” feedback are all welcome.
