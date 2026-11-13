# AWS Emulator MCP — measured AWS service coverage

> **Read this first:** SDK model discovery is **not** AWS Emulator implementation coverage, and an API smoke response is **not** fidelity compared with real AWS.

This is a **version-specific, independently rerunnable local smoke test**. It is not a claim that all operations of any service work, or that AWS security/IAM behavior can be validated locally.

## Snapshot — November 13, 2026

| Measure | Observed | What it means |
|:--|--:|:--|
| Official AWS Emulator | **1.0.343** | Signed package installed into isolated Docker image |
| SDK models available | **436** | Botocore 1.44.2 includes these modeled service names; they are not all necessarily implemented |
| Selected read-only operations | **20** | Explicit allowlist; one safe zero-argument API call per selected service |
| Successful emulator API responses | **20/20** | The **specific calls below** returned successfully in a fresh emulator |
| Full AWS compatibility, IAM correctness, or runtime fidelity | **Not measured** | Must use AWS upstream fidelity reports and app-specific tests |

The signed emulator ran with Docker network disabled, no exposed ports, no host volume mounts and no host AWS credentials forwarded. All 20 operations were called using the real AWS SDK via the `aws_sdk_invoke` bridge or the dedicated read-only coverage command.

## Operations with successful read-only responses

| AWS service (SDK id) | Actual operation | Result |
|:--|:--|:--|
| `sts` | `GetCallerIdentity` | Responded |
| `s3` | `ListBuckets` | Responded |
| `dynamodb` | `ListTables` | Responded |
| `sqs` | `ListQueues` | Responded |
| `ec2` | `DescribeVpcs` | Responded |
| `lambda` | `ListFunctions` | Responded |
| `cloudformation` | `ListStacks` | Responded |
| `iam` | `ListRoles` | Responded |
| `events` | `ListEventBuses` | Responded |
| `sns` | `ListTopics` | Responded |
| `secretsmanager` | `ListSecrets` | Responded |
| `logs` | `DescribeLogGroups` | Responded |
| `apigateway` | `GetRestApis` | Responded |
| `stepfunctions` | `ListStateMachines` | Responded |
| `bedrock` | `ListFoundationModels` | Responded |
| `kms` | `ListKeys` | Responded |
| `rds` | `DescribeDBInstances` | Responded |
| `ecs` | `ListClusters` | Responded |
| `ecr` | `DescribeRepositories` | Responded |
| `ssm` | `DescribeParameters` | Responded |

The original normalized evidence is stored in [docs/evidence/coverage-aws-emulator-1.0.343.json](evidence/coverage-aws-emulator-1.0.343.json). It contains no credentials, resource payloads or private account identifiers.

**Interpretation matters:** A successful Lambda `ListFunctions` call does not establish that function invocation or event triggers work. Likewise, `bedrock.ListFoundationModels` does not prove local model inference, and `iam.ListRoles` does not test real IAM enforcement. Empty list responses may be perfectly valid, but do not imply a service lifecycle is supported.

## Run a fresh audit yourself

~~~bash
aws-emulator-mcp coverage
aws-emulator-mcp coverage ec2 --json
aws-emulator-mcp coverage bedrock --json
~~~

Every run reports the actual emulator version, current modeled-service count, operation, observed status, duration, and the number of successful responses. If a modeled service is **outside** the fixed read-only probe allowlist, its service status is `not_probed`—never quietly considered supported.

### Paging through all SDK service and operation models via MCP

~~~text
aws_sdk_discover({ "offset": 0, "limit": 100 })
aws_sdk_discover({ "offset": 100, "limit": 100 })
aws_sdk_discover({ "service": "ec2", "query": "Describe", "offset": 0, "limit": 40 })
aws_sdk_discover({ "service": "lambda", "query": "List", "offset": 0, "limit": 40 })
~~~

The response uses `nextOffset` for pagination. Every discovered operation is tagged `modeled_not_verified`. Even when an API has a model, AWS Emulator can return `501 Not Implemented` or other errors. An operation is not supported merely because it appears in botocore.

### Dedicated MCP evidence tool

~~~text
aws_sdk_coverage({ })
aws_sdk_coverage({ "service": "ec2" })
~~~

Unlike the broad `aws_sdk_invoke` tool, coverage is restricted to an **audited list of 20 read-only, zero-argument operations**. It cannot receive arbitrary method names, parameters or user code. The 20 calls are **not** a representative statistical sample of all AWS APIs.

## Outcome meanings

| Status | Meaning |
|:--|:--|
| `responded` | The selected API call returned without raising an SDK error from the local emulator |
| `not_implemented` | Emulator indicated HTTP 501 / NotImplemented for the selected operation |
| `api_error` | Emulator returned a different AWS-style error |
| `not_modeled` | The selected API is absent from the installed SDK model |
| `error` | A local client, TLS, validation or runtime failure prevented the operation |
| `not_probed` | Service may be modeled but no safe read-only probe is on the allowlist |

## How to assess real AWS fidelity

AWS publishes [official AWS Emulator releases and fidelity scores](https://github.com/aws/aws-emulator/releases) and a [guide to checking whether your project works](https://docs.aws.amazon.com/emulator/latest/userguide/check-project.html). The upstream tests, exact emulator build and your own application tests are the right basis for any compatibility decision. Our 20 probes measure **observable read-only responses**, not parity, distributed behavior, compute execution, policy correctness or production performance.

## Improving coverage responsibly

Contributions should come with the exact version, API operation, arguments, expected behavior, an isolated reproducible test and a sanitized result. We will not add a green check for a service based only on an SDK model being present. Refer to [CONTRIBUTING.md](../CONTRIBUTING.md) and [the real-Docker smoke test](../tests/docker_bundle_smoke.py).
