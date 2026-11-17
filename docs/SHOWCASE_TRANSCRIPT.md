# AWS Emulator MCP beta.15 narrated demo

**Format:** edited explanatory video with Windows SAPI narration and scene captions.
**Evidence:** beta.15 offline CLI output, GitHub hosted CI run [44102711476](https://github.com/B11-Health/aws-emulator-mcp/actions/runs/44102711476), and reviewed example source.
**Important:** not an uncut recording or an AWS compatibility certification.

## Scene 1 · From bug report to proof (0s)
Narration: An AI coding agent shouldn't just say a pull request looks good. It should help reproduce a bug, verify a change, and show evidence.
Caption: Reproduce the failure  ·  Verify the fix  ·  Review the evidence

## Scene 2 · Try it before installing Docker (9.1s)
Narration: Start with Node.js and Git. Run the offline try command. On our Windows test machine it verified seven architecture files, with zero Docker or AWS calls.
Caption: 7 architecture artifacts verified  ·  0 Docker calls  ·  0 AWS calls

## Scene 3 · One order. Two events. A bug. (21.0s)
Narration: Now use local Docker for real emulator API tests. This sample order handler sends two fulfillment events for one retried order. The reviewed fix sends one.
Caption: Sample app: 2 SQS messages before  →  1 message after

## Scene 4 · A failure between services (31.7s)
Narration: What happens when DynamoDB saves an order but the S3 receipt upload times out? A fragile retry loses the event. Pending-state recovery restores it.
Caption: DynamoDB persisted  ·  S3 receipt failed  ·  Recovery publishes 1 event

## Scene 5 · Bring your own trusted fix (41.8s)
Narration: You can compare two trusted Python handlers you own. Each runs in a separate isolated lab. The report checks the bug, the fix, source hashes, and cleanup.
Caption: Two trusted Python handlers  ·  Two isolated labs  ·  Reviewable evidence

## Scene 6 · See risky changes before merge (53.0s)
Narration: Before approving infrastructure changes, Architecture Review can flag a DynamoDB partition key change. That's a source-level warning, not an AWS change set.
Caption: Partition key: orderId  →  orderRef  ·  Flag for human review

## Scene 7 · Connect a local coding assistant (63.9s)
Narration: Generate a local MCP configuration for your coding assistant. Then ask it to run a reviewed failure test and explain the evidence, not to guess.
Caption: Generate MCP config  ·  Connect editor  ·  Ask for the assertions

## Scene 8 · Make green checks mean something (73.3s)
Narration: These reviewed scenarios passed GitHub CI with signed AWS Emulator version one point zero point four nine one. Local success does not prove AWS production parity or IAM enforcement. Your feedback helps.
Caption: Hosted CI passed  ·  AWS Emulator 1.0.491  ·  NOT AWS production parity

**Total runtime:** approximately 87 seconds.
No AWS account, external speech provider or copyrighted music was used to make this explainer.

**Reproduce commands and limitations:** [Demo studio](https://b11-health.github.io/aws-emulator-mcp/), [Onboarding](ONBOARDING.md), [Failure Lab](FAILURE_LAB.md).
