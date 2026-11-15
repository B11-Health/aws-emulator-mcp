# Replayable AWS SDK contract tests

Build an AWS API experiment as **data** instead of a shell script. Your AI assistant
can propose a contract, run it against a fresh official AWS Emulator, and receive
specific pass/fail evidence. You can keep the JSON contract in your repository
and rerun it as the emulator changes.

## Try it

Requires the [GitHub-source installation](../README.md#get-started), Node.js 20+
and running local Docker.

```bash
aws-emulator-mcp contract demo
aws-emulator-mcp contract demo --json

# After cloning the repository or saving a custom local plan:
aws-emulator-mcp contract examples/contracts/s3-write-read.json
aws-emulator-mcp contract examples/contracts/sqs-consume.json
aws-emulator-mcp contract examples/contracts/ec2-vpc.json
```

The `demo` alias runs the sample bundled with the npm installation.
Each CLI run creates a one-shot network-disabled Docker container using emulator
credentials only. The container and all emulated resources disappear when it exits.

From an MCP client connected to the Docker-based server, call `contract_guide`,
then `contract_run({"plan": ...})`. Each MCP run starts a **separate emulator
process on a random loopback port with its own temporary HOME and keys**.
It does not share state with the MCP session's long-lived emulator.

## Example missions

- [S3 object round trip](../examples/contracts/s3-write-read.json) — create, write,
  read and assert a byte count.
- [SQS delivery and acknowledgement](../examples/contracts/sqs-consume.json) —
  create a queue, send and receive a message, acknowledge it and delete the queue.
- [EC2 network control-plane lifecycle](../examples/contracts/ec2-vpc.json) —
  create a VPC and subnet, verify the relationship and delete them in order.

These are replayable **API tests**, not real compute, network routing or
production IAM exercises. Each independently reruns against a fresh emulator.

## Contract syntax

```json
{
  "schemaVersion": 1,
  "name": "create-queue-contract",
  "steps": [
    {
      "id": "create",
      "service": "sqs",
      "operation": "CreateQueue",
      "parameters": {"QueueName": {"$fixture": "queue"}},
      "expect": {"assertions": [{"path": "QueueUrl", "exists": true}]}
    },
    {
      "id": "inspect",
      "service": "sqs",
      "operation": "GetQueueAttributes",
      "parameters": {
        "QueueUrl": {"$ref": "create.QueueUrl"},
        "AttributeNames": ["QueueArn"]
      },
      "expect": {"assertions": [{"path": "Attributes.QueueArn", "exists": true}]}
    }
  ]
}
```

- Up to 16 consecutive operations. `service` and `operation` use Botocore model
  names (`s3`/`GetObject`, `ec2`/`DescribeVpcs`, etc.).
- `parameters` are JSON AWS SDK arguments; no Python, shell, `eval`, URL or
  custom endpoint.
- `{"$fixture":"bucket"}` substitutes a random unique name. Available fixture
  names are `bucket`, `table`, `queue`, `id`.
- `{"$ref":"create.QueueUrl"}` reads a path from a **previous successful** step.
  JSON keys and array indexes use dotted paths (e.g. `Buckets.0.Name`).
- `expect.assertions` accepts `{"path":"...","equals":...}` or
  `{"path":"...","exists":true}`. You can compare against references or fixtures.
- `expect.errorCode` asserts an expected AWS-style API error instead of success.
- Any mismatch stops the sequence and returns nonzero exit status. Reported
  evidence contains operation IDs, assertion booleans, response SHA-256 hashes,
  emulator version and a plan hash. Raw request/response content is withheld.

## Scope and constraints

The runner checks the emulator's isolated STS account before any operation.
Docker networking is disabled; the container has no published ports, host
volumes or forwarded AWS credentials. MCP contracts are additionally separated
from the main session with independent emulator state.

**This executes arbitrary SDK operations, not arbitrary code.** It can
create or delete synthetic resources **only within the emulator**. Be deliberate
about which API operations you choose. A modeled service might return 501 or
different behavior from real AWS. No IAM enforcement, production compatibility,
security validation, billing, Lambda execution or crash atomicity is implied.
Use only synthetic data. The SDK responses are hashed, not disclosed; an
expected error is accepted only when its actual API error code matches.

This is a beta interface: keep contracts under version control and inspect
reported assertions before depending on it in CI.
