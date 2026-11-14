# What you can build with AWS Emulator MCP

**AWS is the cloud. The emulator is your workshop. AWS Emulator MCP lets an AI assistant use the workshop.**

When you ask your assistant to create an S3 object, store a DynamoDB record or send an SQS message, these aren't diagrams or simulated chat answers. The MCP calls the **running official AWS Emulator on your computer**, which implements supported AWS-style API operations.

The resources are **synthetic and temporary**, and the emulator's fidelity is limited. That's useful for learning, prototyping and local integration tests—not a replacement for actual AWS security or production testing.

## Start here: the 3-minute experience

After installing and connecting the **local MCP (29 curated tools; three additional SDK bridge tools inside Docker)**, ask:

> **Check the AWS Emulator, then run the synthetic order-processing demo. Show every AWS service operation, the deliberate missing-receipt error, how it was recovered, and the cleanup checks.**

**Expected proof:** 12 steps, 2 expected recovery assertions, 4 cleanup checks. The names and timings are generated per run. The demo creates **no real AWS infrastructure**.

On Windows, the same scenario runs with **demo.cmd** after **install.cmd**. On Linux, run **bash scripts/order_demo_linux.sh**. See [reproducible order demo](../examples/order_workflow.md).

## Six practical experiments

### 1. Make your own object-storage lab (S3)

Imagine a website storing text receipts, exported reports or customer notes.

**Try asking:**

> Create a uniquely named S3 bucket in my AWS Emulator. Put the text “hello from my local cloud” under notes/welcome.txt. Retrieve it and prove the content is identical. List the bucket. Delete the object and bucket you created.

**What you learn:** the difference between a bucket and an object, object keys, how uploads and downloads work, and why cleanup matters.

**Tools involved:** s3_create_bucket, s3_put_object, s3_get_object, s3_list_objects, s3_delete_object, s3_delete_bucket.

**Today:** available through the local MCP. Objects are UTF-8 text only; this MCP isn't yet a general binary-media upload tool.

### 2. Make a background-job queue (SQS)

Imagine an app that must process orders or send notifications without making users wait.

**Try asking:**

> Create a temporary SQS queue for sample thumbnail jobs. Send three text messages containing different job IDs. Receive and read the messages. Acknowledge each successfully received message and delete only the queue you created.

**What you learn:** enqueueing, polling, message receipt handles and acknowledgement. An SQS queue stores *work to be processed*, not the finished application.

**Tools involved:** sqs_create_queue, sqs_send_message, sqs_receive_messages, sqs_delete_message, sqs_delete_queue.

**Today:** available through the local MCP for text messages in standard queues. There is **no automatic worker or Lambda trigger** in this example.

### 3. Make a tiny records database (DynamoDB)

Imagine storing a simple inventory item or ticket status.

**Try asking:**

> Create a temporary DynamoDB table in the local emulator. Store two example records using a unique id and message for each. Read them back, verify the values, describe the table, and delete the table you created.

**What you learn:** key-based lookups, table creation, record shape, and validating the result of an API operation.

**Tools involved:** dynamodb_create_table, dynamodb_put_item, dynamodb_get_item, dynamodb_describe_table, dynamodb_delete_table.

**Today:** available through the local MCP with a deliberately narrow **id/message string** schema. Complex query expressions and arbitrary attribute types are outside this MCP version.

### 4. Build an order pipeline (DynamoDB + SQS + S3)

Imagine an online shop receiving an order and preparing a receipt and fulfillment request.

**Try asking:**

> Run emulator_order_demo. Show me the synthetic order stored in DynamoDB, the message sent to and received from SQS, the first S3 receipt request failing as expected, the receipt created and fetched successfully, the queue message acknowledged, and the cleanup report.

**What you learn:** how multiple infrastructure primitives form one workflow, what errors look like, and how to verify the full path rather than only individual requests.

**Today:** a **built-in, repeatable working demo**. The orchestration lives inside the MCP workflow. This is not a real checkout/payment processor and does not automatically invoke Lambda.

### 5. Prototype a warehouse or support-ticket intake

Imagine a fulfillment desk accepting deliveries, or a helpdesk accepting issues.

**Try asking:**

> Create a sample intake record in DynamoDB, queue an action containing that record ID, store a text note in S3, then read all three back and show how an application might connect them. Clean up only the resources created for this example.

**What you learn:** the common cloud pattern of **data + work queue + object storage**, which underlies logistics, e-commerce, support tools and many internal applications.

**Today:** the individual APIs can be composed in an MCP conversation. The **business rules, concurrency control, idempotency, notifications, user authentication and UI** would still need separate application code.

### 6. Learn from an actual error

Imagine teaching a new developer how an API handles invalid or missing resources.

**Try asking:**

> In my AWS Emulator, deliberately look up an S3 object that hasn't been created. Show the actual error. Then put the object there, read it back, verify the content, and remove only what this lesson created.

**What you learn:** error codes, the difference between an expected error and a failure, and how to write assertions around recovery.

**Today:** missing-receipt recovery is explicitly implemented in emulator_order_demo. Other errors depend on the supported API and the emulator version.

## Another audience: developers running automated checks

The emulator can also be used through AWS SDKs and AWS CLI in software tests. AWS Emulator MCP ships a repeatable S3/DynamoDB/SQS test and a benchmark that creates temporary resources, measures completion, and verifies cleanup.

For a local test run (from a configured source environment), use:

~~~bash
python3 -m unittest discover -s tests -q
python3 scripts/live_test.py
python3 scripts/gtm_benchmark.py --repetitions 5
~~~

The result includes **reports/gtm_latest.json** and an offline HTML dashboard. Hosted CI also verifies the source against signed official emulator binaries. These measure **local emulator behavior**, not real AWS availability or production throughput.

## Why is the conversational interface useful?

An AWS CLI expert could do many of these operations directly with shell commands. **MCP isn't a new cloud; it's a tool interface.**

| Without this MCP | With this MCP, in a compatible client |
| --- | --- |
| You choose CLI syntax and service-specific flags. | You describe an intent; the assistant selects a supported tool. |
| You manually handle connection details and commands. | The adapter uses local emulator-generated credentials and HTTPS. |
| You inspect output and decide what to check. | The agent can read outputs and request follow-up verification. |
| You create scripts for multi-service exercises. | You can run the predefined order workflow and inspect its evidence. |
| You must decide what is safe to delete. | Built-in examples clean up only the unique resources created for that run. |

**It's especially helpful for people learning cloud concepts and for AI developers who want agents to experiment locally.** Advanced developers may prefer CLI/SDK for unsupported or more complex operations.

## Which features belong to AWS, and which belong to AWS Emulator MCP?

- **AWS Emulator (official AWS project):** local API server, emulator credentials and certificates, AWS SDK/CLI compatibility, supported emulated AWS operations, official agent skill and published fidelity measurements.
- **AWS Emulator MCP (independent project):** 29 curated local MCP tools, simple text-oriented S3/DynamoDB/SQS operations, guided diagnostics, repeatable synthetic order workflow, cleanup verification, MCP compatibility and engineering reports.
- **Your own application:** payment handling, real workers, business logic, user interfaces, authorization, sophisticated data structures, deployments and production monitoring.

The emulator does **not** enforce production IAM policies. Its in-memory state is disposable. Some AWS APIs are unsupported and may return 501. Always read [AWS's documentation](https://docs.aws.amazon.com/emulator/) and compare the fidelity of the emulator version being tested.

## Local MCP vs ChatGPT web: don't confuse them

The **local MCP** has 29 tools, including writes. It is for compatible MCP clients running on or attached to the same machine.

The existing, separately branded legacy **Secure QA** plugin in ChatGPT web provides **only three read-only diagnostics**: emulator_status, emulator_doctor, emulator_identity. It uses an independently authenticated connector; it cannot create buckets or queues or run emulator_order_demo remotely.

A remote **write-capable** plugin must be deliberately designed with per-user approval and authorization. We don't describe the current read-only plugin as full control.

## Ideas beyond the current release

These are **possible future recipes**, not capabilities we claim are working in this MCP today:

- Explore supported **Lambda + EventBridge + API Gateway** API operations.
- Test **Terraform/CDK/SAM** application configuration through agent-controlled CLI integrations.
- Create isolated emulator instances for each coding agent or each test.
- Build a local visual explorer for tables, buckets, messages and call history.
- Try intentionally failing application code, patch it, rerun an integration test and show evidence.
- Write a beginner's interactive lab curriculum for real AWS-style API semantics.

The first release succeeds when someone can **install it, ask for one concrete experiment, see genuine emulator results, and reproduce the outcome**—not when the repository has the longest list of speculative features.

---

**Next:** [Install and run it](../README.md#quickest-install-on-windows) · [Order workflow evidence](../examples/order_workflow.md) · [Security boundaries](../SECURITY.md) · [Official AWS Emulator](https://github.com/aws/aws-emulator)


### Beyond the curated S3, SQS and DynamoDB tools

The isolated Docker MCP includes three additional SDK bridge tools, so a local agent can discover any operation modeled by its installed botocore version, invoke those that AWS Emulator implements, and measure **20 allowlisted read-only API probes**. The [verified coverage snapshot](COVERAGE.md) records successful read-only responses from 20 different service areas on AWS Emulator v1.0.343. SDK model discovery is not implementation proof or AWS parity.


### Five additional verified AWS-style lab workflows (beta.5)

Use the isolated Docker CLI to discover and run eight total missions, or call the existing `lab_catalog` / `lab_run` tools from a trusted local MCP client:

~~~bash
aws-emulator-mcp experiments
aws-emulator-mcp experiment sns-sqs-delivery
aws-emulator-mcp experiment ec2-vpc-lifecycle
aws-emulator-mcp experiment eventbridge-bus
aws-emulator-mcp experiment ssm-parameter
aws-emulator-mcp experiment secretsmanager-secret
~~~

**Important distinctions:** the SNS/SQS lab verifies actual message delivery (with explicit queue policy), while the EventBridge lab checks bus creation and successful event submission **without claiming event routing**. The EC2 experiment tests control-plane resource lifecycle **without launching a VM or transmitting network traffic**. Parameter Store and Secrets Manager use synthetic values; they do not validate production IAM, encryption or rotation.


### Debug a real app bug (beta.6)

Ask your local AI agent to inspect `app_debug_catalog` source,
reproduce a duplicate-order failure, and propose a conditional DynamoDB
write. `app_debug_run` verifies both packaged variants against
fresh local emulator resources. **Two SQS events before, one after**,
with seven cleanup checks each. Arbitrary agent-generated code is not
executed by this developer beta.
[Read the complete debugging walkthrough](APP_DEBUGGING.md).
