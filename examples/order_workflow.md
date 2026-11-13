# Example: Synthetic order processing

This example uses an existing local official AWS Emulator and the AWS Emulator MCP bridge. It is not a deployment to AWS.

## One-click demo on Windows

After install.cmd succeeds, double-click demo.cmd.

The output includes a synthetic order ID, a count of passed steps, recovery checks, resource cleanup, and a local evidence report in the installed reports directory.

## Linux shell demo

From the source checkout:

    bash scripts/order_demo_linux.sh

## As an MCP agent tool

Once the MCP client is configured, ask:

> Use emulator_doctor to verify the sandbox. Run emulator_order_demo. Show me the S3, DynamoDB and SQS steps, the expected receipt-read failure, how the missing receipt was repaired, the readback assertions, and proof that only run-specific resources were cleaned up. If a check fails, explain it rather than claiming success.

The emulated test order has a synthetic SKU and fictitious total. The code makes a deliberate S3 missing-object read, writes the receipt, then verifies the data. No Lambda invocation or SQS event trigger is implied. The flow is orchestrated by the local MCP tool.

## Expected result

- 12 workflow steps pass.
- 2 expected failure/recovery assertions pass.
- 4 cleanup operations succeed.
- All resources use unique names created for the run.

If cleanup fails, the report gives the specific synthetic names for manual inspection. Do not delete unrelated buckets, queues, or tables.

## What would be next?

To build a truly event-driven application, separately test Lambda, API Gateway, EventBridge, and Step Functions through AWS Emulator on a version that supports the desired operations. Add distributed traces, retry scenarios and a real recording with raw logs only after those tests exist.
