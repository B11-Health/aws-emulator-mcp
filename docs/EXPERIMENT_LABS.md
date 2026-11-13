# Reproducible AWS experiments (developer preview)

**AWS Emulator MCP** includes a small catalog of fixed synthetic scenarios that an MCP-compatible AI coding agent can inspect, execute and report as evidence. They use the *actual local AWS Emulator API*, not mocks or scripted success messages. An AWS SDK model existing does not mean the upstream emulator implements an API.

## One-command walkthrough

Requires Node 20+, a running **local** Docker daemon, and the current AWS Emulator MCP source beta. The `experiments` catalog command itself needs only Node.js and does not start Docker.

```sh
aws-emulator-mcp experiments
aws-emulator-mcp experiment s3-recovery
aws-emulator-mcp experiment dynamodb-overwrite --json > experiment-evidence.json
aws-emulator-mcp experiment order-recovery
```

An AI assistant with a local MCP connection can call `lab_catalog` to find supported experiments, then `lab_run` with an `experiment` from the allowlist. There is no shell execution, user-supplied script, external URL, or arbitrary resource selector in these tools.

| Lab | What gets tested against the emulator | Expected failure | Resource cleanup |
| --- | --- | --- | --- |
| `s3-recovery` | S3 CreateBucket, GetObject, PutObject, ListObjectsV2, DeleteObject, DeleteBucket, ListBuckets | Missing object returns 404 before it is written | Delete the object, bucket, and verify absence |
| `dynamodb-overwrite` | DynamoDB CreateTable, PutItem, GetItem, DeleteTable, ListTables | None: demonstrates an intentional overwrite, **not** a concurrency fault | Delete the table and verify absence |
| `order-recovery` | S3 + DynamoDB + SQS synthetic order lifecycle | S3 receipt missing before repair | Four scoped cleanup actions |

## What evidence looks like

Each JSON report includes a stable schema version, experiment identifier, services used, pass/fail, individual API assertions with elapsed time, expected errors, cleanup checks, an error when applicable, and explicit limitations. Names are random and scoped to the run. The raw report can be saved from stdout to a file for CI reviews. The agent should always report individual failed checks instead of treating expected errors as overall success.

**Important:** These are small educational experiments, *not* a general chaos injector, a Terraform/CDK deployer, a cloud security/IAM auditor, a trace replay engine, or a proof of AWS fidelity. No production AWS profile is passed into the Docker lab. The emulator is a development/testing tool whose service coverage varies and whose IAM policies do not provide production security guarantees. A failed cleanup returns a failed experiment even if all functional assertions passed.

## Building on this foundation

1. Add externally reviewable, versioned experiment manifests with strict validation and no arbitrary code execution.
2. Generate reproducible GitHub Actions artifacts so a failed PR produces the exact tested API sequence and sanitized results.
3. Compare recorded assertions across emulator versions and distinguish **implemented**, **unsupported (501)**, and **untested**, without conflating SDK model discovery with coverage.
4. Connect project-specific integration tests in an explicitly opted-in sandbox, preserving the current no-mount/no-network default for built-in experiments.
5. Create agent debugging challenges where a solver receives failure evidence and must produce a passing patch, graded against held-out tests.

These are roadmap ideas, not shipped capabilities. The initial registry has three allowlisted synthetic experiments.
