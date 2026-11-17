# Why use AWS Emulator MCP instead of the native AWS Emulator?

**Most developers should start with the native [AWS Emulator](https://aws.amazon.com/blogs/aws/test-your-applications-against-aws-locally-with-aws-emulator/).** It already accepts familiar AWS SDK and CLI calls, runs on a local endpoint, supports coding agents and CI, and doesn't need an AWS account. You do not need our adapter merely to call S3, SQS or DynamoDB.

[**AWS Emulator MCP**](https://github.com/B11-Health/aws-emulator-mcp) is an **independent open-source integration**, not an AWS service or an AWS-endorsed project. It adds a deliberately bounded set of MCP tools and repeatable application/CI workflows on top of the upstream emulator. Our claim is **reproducibility and inspectable evidence for specific reviewed scenarios**, not expanded AWS service coverage.

## What the extra layer actually changes

| Developer's job | Native AWS Emulator | This independent MCP adapter |
| --- | --- | --- |
| Run ordinary AWS API calls through SDK/CLI | **Preferred**. Use existing code and familiar tooling. | The 38-tool curated MCP surface adds an extra abstraction; do not use it just for parity. |
| Ask a coding agent to reproduce a duplicate-order event | Possible with your own script/test harness. | Bundled S3/DynamoDB/SQS order demo shows 2 accepted submissions and 2 messages before a conditional-write fix, then 1 and 1. |
| Test a synthetic failure across a multi-service workflow | Write and run the fixture yourself. | Reviewed Failure Lab scenarios inject a bounded SDK timeout, verify persisted state and retry behavior against isolated emulator APIs, then test cleanup. |
| Compare your own *trusted* Python order handler before/after a fix | Use your own Python tests. | Explicit **local CLI** `app-compare` runs two developer-selected handlers in separate Docker labs and exports sanitized assertion results plus source hashes. **Not available over MCP.** |
| Examine a proposed infrastructure change in a pull request | CloudFormation change sets require an appropriate AWS workflow; native tools remain authoritative. | Read-only Architecture Review Action compares an allowlisted three-service source blueprint, generates diagram and CloudFormation drafts, and conservatively flags a DynamoDB partition-key change. **Not a real change set.** |
| Check IAM policy enforcement or actual AWS production fidelity | Requires separate AWS validation; the emulator does not evaluate IAM policies like production AWS. | **Not supported.** The adapter cannot manufacture upstream fidelity and does not make local pass equivalent to production safety. |

The example tests, source and cross-repository PR Actions are **maintainer-operated evidence**. They are not independent adoption reports or endorsements. The latest [CI checks](https://github.com/B11-Health/aws-emulator-mcp/actions/workflows/tests.yml) run the official MCP clients and a signed AWS Emulator, but do not certify AWS parity.

## Try the distinction before you download Docker

From a checkout of the **v0.4.0-beta.15 release**:

```bash
git clone --depth 1 --branch v0.4.0-beta.15 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs try --json
```

That checks the **offline architecture generator only**: seven artifacts, a reviewed S3/DynamoDB/SQS resource graph and an **unexecuted** 14-step synthetic SDK contract. It writes to an ephemeral folder and removes it. It doesn't start AWS Emulator, test IAM or make cloud calls. If you want to keep those files, use `node bin/aws-emulator-mcp.mjs architecture demo`.

For actual emulator-backed application behavior, you need a **local Docker Engine with Linux containers**, sufficient disk space, and an internet connection for the initial signed package download:

```bash
node bin/aws-emulator-mcp.mjs preflight --json
node bin/aws-emulator-mcp.mjs doctor
node bin/aws-emulator-mcp.mjs app-debug compare
node bin/aws-emulator-mcp.mjs failure-lab partial-compare
```

The final scenario injects a **synthetic pre-call S3 receipt timeout after DynamoDB persisted the order**. The fragile app leaves a missing receipt and missing queue event; the pending-state app repairs them after a retry. That is **not** a process crash, real AWS outage or proof of a transactional outbox. See [Failure Lab methodology](FAILURE_LAB.md).

## The tradeoffs and limits

- **More moving parts:** the adapter, Node.js and local Docker add complexity beyond calling upstream AWS Emulator directly. If your SDK tests already do everything you need, this project may be redundant.
- **Service fidelity remains upstream:** an API model, an HTTP response, or a CloudFormation lifecycle status does not guarantee complete service behavior. See [measured coverage and methodology](COVERAGE.md).
- **IAM and production safety are separate:** the emulator does not enforce production IAM/resource policies. Always validate real access controls and integration behavior in appropriate AWS test accounts before deployment.
- **Source execution has a strict boundary:** developer-selected Python handlers run only after an explicit local CLI command. Do **not** feed the command untrusted pull-request code. Docker isolation is defense in depth, not a security guarantee against malicious code. The remotely callable MCP adapter and read-only PR gate cannot execute arbitrary supplied source.
- **Infrastructure output is a proposal:** generated CloudFormation and diagrams are only the explicitly supported S3/DynamoDB/SQS subset and require independent review. No tool in the default adapter deploys to AWS.
- **Release clarity:** use a reviewed tag or commit; later changes to `master` are not automatically part of beta.15.

## What would make it worth installing?

If a reviewer has a **concrete reproducible failure** that an AI assistant should catch before PR merge, please describe the service/API operation, expected invariant and alternative test setup. A critical review explaining **why you would use the native AWS SDK/CLI instead** is equally valuable. [Developer feedback](https://github.com/B11-Health/aws-emulator-mcp/issues/26) · [Short field report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml).
