# The AWS API succeeded. My application was still wrong.

*An independent AWS Builder Center article draft — not published. Technical community write-up, not an AWS partnership announcement.*

**Summary:** AWS Emulator lets developers test AWS API behavior locally. But a successful API call is different from a correct application outcome. Two reproducible Python examples show how independent AWS-state assertions can give both developers and coding agents stronger feedback before deployment.

**Suggested tags:** aws-emulator, aws, agentic-ai, testing, s3, sqs

---

AWS recently launched [AWS Emulator](https://aws.amazon.com/blogs/aws/test-your-applications-against-aws-locally-with-aws-emulator/), a local way to exercise supported AWS APIs from familiar SDKs and the CLI, without opening an AWS account. That removes a meaningful source of friction when a developer or coding agent is iterating on AWS integrations.

But I've been exploring a separate question: **when an SDK operation succeeds, how do we know our application did the right thing?**

That question matters even more with AI coding agents. In [Better feedback for building with agents](https://aws.amazon.com/blogs/aws-insights/better-feedback-for-building-with-agents/), AWS argues that agents need fast feedback before an incorrect assumption compounds into more code. Local emulation helps. I wanted to add one more layer of evidence: independent checks against the state left behind by the *application*, not just its return value.

## Example 1: Both S3 writes succeeded. Only one was correct.

I tested two small, self-contained Python handlers against a locally built AWS-signed Emulator **1.0.511** package. Both used the same synthetic S3 test case and called `PutObject` exactly once.

The deliberately incorrect handler stored a 13-byte object; the reviewed case expected 12 bytes. The other stored the intended 12 bytes. Both SDK writes succeeded.

What distinguished the two was a *separate* SDK `HeadObject` read, asserting `ContentLength == 12` after the application returned.

| Check | Incorrect handler | Correct handler |
| --- | --- | --- |
| `PutObject` accepted by local emulator | Yes | Yes |
| Independent `HeadObject.ContentLength` assertion | **Fail** | **Pass** |
| Declared synthetic cleanup | Pass | Pass |
| Reported local application result | Fail | Pass |

Nothing about this required production AWS, an AWS account, or customer data. The source files, case SHA-256, emulator version, observed call counts, failed/passing assertion and cleanup can all be checked in the [draft recorded evidence](https://github.com/B11-Health/aws-emulator-mcp/blob/release/agent-team-preview-20261118/docs/evidence/guided-app-case-aws-emulator-1.0.511.json).

This is deliberately a narrow claim. It establishes **one local application invariant** on **one emulator release**. It is not proof that every S3 feature is production-equivalent.

## Example 2: An order was stored, but the customer could receive duplicate messages.

In another project-maintained test, a Python order handler wrote to DynamoDB and sent an SQS message. Invoking the fragile handler twice for the same logical order caused **two** SQS messages; the corrected handler used a conditional DynamoDB write and sent only **one**.

Again, the SDK operations being accepted weren't enough. Independent SDK reads checked the stored item's typed fields and looked for an unwanted second message. In the signed local Emulator **1.0.506** record, the intentionally broken handler passed 3 of 4 postcondition assertions and failed exactly the named `receive.Messages.1` check. The corrected handler passed all 4. Both cleaned up.

The [recorded SQS evidence](https://github.com/B11-Health/aws-emulator-mcp/blob/release/agent-team-preview-20261118/docs/evidence/app-case-aws-emulator-1.0.506.json) is project-authored, not an independent AWS test certification.

## A repeatable feedback loop for agents

The practical workflow I've been using is:

1. **Inspect** the developer's own Python AWS handler without importing it or executing it. Identify literal SDK calls and input names.
2. **Define a case** with synthetic setup, expected SDK operations, independent postconditions and owned cleanup.
3. **Run it locally** against an isolated emulator only after explicitly reviewing and approving that trusted source.
4. **Challenge it** with an intentionally incorrect baseline or negative control. An evaluator that always returns green isn't useful.
5. **Report** exact case/source hashes, emulator version, observed SDK counts, named failed assertions, and cleanup. Keep source, payloads, credentials and exceptions out of the public artifact.
6. **Hand off to AWS deliberately** for separate production-environment validation, IAM checks, cost review and deployment approval.

The official AWS Emulator, its agent skill and the AWS SDK already own the API and installation layers. The additional part here is a small, independent [application-verification workbench](https://github.com/B11-Health/aws-emulator-mcp), not another emulator or a replacement for AWS's toolchain.

## Reproduce the smaller first step

From the **draft integration preview branch**, with Node.js 20+:

```sh
git clone --depth 1 --branch release/agent-team-preview-20261118 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp

# No Docker or AWS account: verifies seven local architecture artifacts.
node bin/aws-emulator-mcp.mjs onboard --offline --json

# Read-only inspection; requires Python 3.10+, does not execute source.
node bin/aws-emulator-mcp.mjs app-guide examples/app-case/s3-upload.py examples/app-case/s3-object-write.json --json
```

The CLI then describes how to review the exact case and opt into a signed local Docker emulator run. Actual emulator-backed calls require Linux-container Docker and enough disk capacity for a sizable image. **Do not execute untrusted Python code**: Docker isolation is not a sandbox for hostile source. The currently published beta.15 release does **not** contain these newer commands.

## Where this could go next

AWS has an open [feature request for DevOps-agent benchmarks](https://github.com/aws/aws-emulator/issues/7). The work here is **not AWS-Bench compatible** and hasn't produced benchmark scores. It does suggest a useful question: would a simple task-result interchange format containing emulator version, setup, bounded agent action, independent postconditions, a negative control, cleanup and limitations help external evaluators plug into the official emulator?

I also made a [small, read-only recorded evaluation export](https://github.com/B11-Health/aws-emulator-mcp/blob/release/agent-team-preview-20261118/docs/AGENT_EVALUATION.md) as a conversation starter, not a request for endorsement.

**My question for other builders:** when you use an AI coding agent with AWS, what's the hardest application outcome to verify after its SDK calls succeed?

---

*This article is an independent developer experiment. The official AWS Emulator supports a growing subset of AWS behavior, and its [fidelity documentation](https://docs.aws.amazon.com/emulator/) should determine the limits of any local test. No claims of AWS partnership, acquisition discussions, external adoption, production IAM validation or broad AWS parity are made here. This draft has not been posted to AWS Builder Center.*
