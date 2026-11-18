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
aws-emulator-mcp contract fault-demo --json

# After cloning the repository or saving a custom local plan:
aws-emulator-mcp contract examples/contracts/s3-write-read.json
aws-emulator-mcp contract examples/contracts/sqs-consume.json
aws-emulator-mcp contract examples/contracts/ec2-vpc.json
aws-emulator-mcp contract examples/contracts/sqs-before-call.json
aws-emulator-mcp contract examples/contracts/sqs-after-success.json
```

The `demo` alias runs the sample bundled with the npm installation.
Each CLI run creates a one-shot network-disabled Docker container using emulator
credentials only. The container and all emulated resources disappear when it exits.

From an MCP client connected to the Docker-based server, call `contract_guide`,
then `contract_run({"plan": ...})`. Each MCP run starts a **separate emulator
process on a random loopback port with its own temporary HOME and keys**.
It does not share state with the MCP session's long-lived emulator.

## Start with an existing Python app

From the MCP development checkout, select your app's Git directory, a tracked
subdirectory, or a single Python module. The planner reads the working copy.
It parses Python syntax locally. Your app stays unexecuted and Docker is
needed only when you decide to run a contract.

```sh
node bin/aws-emulator-mcp.mjs project-plan /path/to/app
node bin/aws-emulator-mcp.mjs project-plan /path/to/app --json
node bin/aws-emulator-mcp.mjs project-plan /path/to/app --contract sqs > queue-contract.json
node bin/aws-emulator-mcp.mjs contract queue-contract.json --json
```

Planning needs Python 3.10+ on PATH. Directory mode also needs Git and
considers up to 256 tracked Python files, 128 KiB per file and 4 MiB total.
Single-file mode also works on an untracked module. The JSON lists every
analyzed or skipped file, call sites, unmatched methods, additional probe
operations and keyword arguments absent from each draft. Source payloads,
environment values and application resource names stay out of the generated
contract. Review the synthetic inputs and assertions before running it.

Discovery recognizes direct low-level `boto3.client("service")` calls, import
aliases, and receivers assigned once in a straight-line module or function
body. Static discovery can include dead branches and miss injected clients,
wrappers, dynamic factories and Boto3 resources. Matching a keyword name
also leaves its actual value and application logic untested.

A connected assistant can pass just method identifiers to `contract_guide`:

```json
{"clientMethods":["sqs.get_queue_url","sqs.send_message","lambda.invoke"]}
```

The result includes an SQS contract with queue lookup, send, receive,
acknowledgement and cleanup. It lists `lambda.invoke` as unmatched. Review
a returned `drafts[].plan` and pass that object to `contract_run` to get
per-step emulator evidence. Bundled drafts cover selected S3, SQS, DynamoDB
and EC2 operations. Calling `contract_guide` without arguments still returns
the original authoring guide.

## Example missions

- [S3 object round trip](../examples/contracts/s3-write-read.json) — create, write,
  read and assert a byte count.
- [SQS delivery and acknowledgement](../examples/contracts/sqs-consume.json) —
  create a queue, send and receive a message, acknowledge it and delete the queue.
- [EC2 network control-plane lifecycle](../examples/contracts/ec2-vpc.json) —
  create a VPC and subnet, verify the relationship and delete them in order.

- [SQS timeout before send](../examples/contracts/sqs-before-call.json) -
  inject a one-shot SDK timeout before the first send, verify that the queue
  is empty, retry, read the message and acknowledge it.
- [SQS lost acknowledgement](../examples/contracts/sqs-after-success.json) -
  send the message to the emulator but suppress its successful SDK response,
  retry, then receive and acknowledge two separate messages.

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
- A single `"fault": {"mode": "before-call"}` prevents a selected SDK write
  from reaching the emulator. `"after-success"` forwards that same API call
  successfully before a synthetic `RequestTimeout` is returned to the runner.
  The fault step must use `"expect": {"errorCode": "RequestTimeout"}`.
  Supported writes in this beta: `sqs.SendMessage`, `s3.PutObject`,
  `dynamodb.PutItem`. Multiple faults, arbitrary exceptions, delays,
  shell execution and code loading are rejected.
- `expect.errorCode` asserts an expected AWS-style API error instead of success.
- Any mismatch stops the sequence and returns nonzero exit status. Reported
  evidence contains operation IDs, assertion booleans, response SHA-256 hashes,
  emulator version and a plan hash. Raw request/response content is withheld.

## Run these contracts on every pull request

The [PR contract gate](CI_CONTRACT_GATE.md) gives a coding agent's declarative
tests a GitHub Actions status check and a downloadable redacted evidence report.
Add one or more `.json` files, use the pinned composite action in a repository
workflow, and make the resulting job a required check if you want it to block
merges. The gate accepts a flat folder with at most six contracts, and each
plan runs in its own isolated local emulator.

You can test the same folder without GitHub Actions:

```bash
aws-emulator-mcp gate .aws-emulator/contracts
```

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

## Ask an agent to generate a failure contract for your own workflow

Use your coding agent's normal source-reading capability in **your own
repository** to inspect a Python, Node or other AWS-SDK integration (the
emulator itself cannot see host files). Ask the agent to identify one SDK
write, its retry path and a state observation, then produce a reviewed JSON
contract using the examples above. Execute it with
`aws-emulator-mcp contract <your-plan.json> --json` or `contract_run`.
The plan is data and does not include user source code.

**Important boundaries:** A successful generated contract shows how the
**emulated API operations in that plan** behave under the injected fault. It
does **not** execute your application, automatically prove your actual retry
implementation, or represent a live AWS outage. Validate application
behavior separately with an integration harness. In particular,
`after-success` guarantees only that this specific emulator SDK call
returned successfully before the wrapper hid the response.

The JSON evidence explicitly distinguishes `synthetic_sdk_timeout` from
genuine API errors, and `sentToEmulator` documents which side of the API
boundary the timeout occurred on. Raw values are withheld.

This is a beta interface: keep contracts under version control and inspect
reported assertions before depending on it in CI.
