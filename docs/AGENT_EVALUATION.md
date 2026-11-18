# A small, framework-neutral application evaluation handoff for AWS agents

**Independent community experiment — not an AWS product, AWS-Bench task,
benchmark result, certification or endorsement.** This document proposes a
small *test-result interchange format* complementary to the official
[AWS Emulator](https://github.com/aws/aws-emulator) agent skill and the open
[DevOps-agent benchmark request](https://github.com/aws/aws-emulator/issues/7).
We have not received approval or commitment from AWS to support this format.

## What a developer actually needs to establish

An agent can make an AWS SDK call successfully while its **application is
incorrect**. For example, a fragile order handler may write a DynamoDB
record successfully and send two SQS messages for one logical order. The
problem is detected only when an **independent** read checks the final queue
state. Therefore a useful evaluation should distinguish three separate facts:

1. **Setup and modeled API execution:** were synthetic resources created and
   which expected SDK operations were attempted and succeeded?
2. **Independent application postconditions:** did the emulator state match
   developer-authored invariants (including deliberately negative controls)?
3. **Cleanup and limitations:** were owned synthetic resources removed, on
   which emulator version, and what is *not* proved by the result?

This is a possible *building block* for an agent benchmark, not a standalone
measurement of agent skill, real AWS fidelity or security.

## Inspect the recorded reference case without Docker or AWS

From the development checkout:

```sh
node scripts/agent_eval_handoff.mjs --json
node scripts/agent_eval_handoff.mjs --markdown
```

This read-only exporter loads **only the tracked** case, Python source files
and sanitized AWS Emulator 1.0.506 evidence already bundled with the project.
It validates source hashes, the exact case hash, emulator version, recorded
postconditions, SDK counters, and cleanup using the same fail-closed verifier
as the local application-case runner. It performs **no new AWS/emulator calls**
and does not execute the Python files. It exits nonzero when evidence is
inconsistent or when the recorded before/after fix is not verified.

[Open the frozen machine-readable sample](../examples/agent-eval/sqs-idempotency-recorded.json).
The result is a project-maintained **consistency check over recorded evidence**,
not an independently signed attestation. The frozen JSON must match the output
of the exporter; tests enforce that correspondence.

| Evidence field | Example meaning |
| --- | --- |
| `case.sha256` | Hash of the exact declarative SQS + DynamoDB scenario |
| `candidate.brokenSourceSha256`, `fixedSourceSha256` | Two different Python source revisions |
| `emulator.version` | One exact signed AWS Emulator version used for both recorded runs |
| `observed.before.assertions` | 3/4 independent readback assertions passed; the named second-message assertion failed |
| `observed.after.assertions` | 4/4 independent readback assertions passed |
| `observed.*.sdkCalls` | Attempt/success counts through the test-injected SDK clients |
| `result.negativeControlDetected` | Specifically intended broken behavior reproduced, without unrelated failures |
| `result.cleanupVerifiedBoth` | Declared cleanup succeeded in both recorded runs |
| `metadata.productionAWSValidated` | `false` — no real AWS account was contacted |

A code change or contradictory report that alters its source hash, case hash,
expected assertion, cleanup status or emulator version must fail the evaluator,
not silently produce a positive score. No payloads, application logs or AWS
credentials are included in the export.

## Where official AWS integration could help

The open AWS issue concerns representative **DevOps agent benchmark tasks**,
including infrastructure provisioning and troubleshooting. Our sample is
**one trusted Python application behavior test**, **not** an AWS-Bench task.
It cannot establish benchmark compatibility, task completion rate, cost or
agent autonomy. A useful initial collaboration question is whether AWS would
prefer a simple result schema carrying a fixed emulator version, task setup,
agent action, independent postconditions, a negative control, cleanup evidence
and known fidelity limits. If AWS has a preferred schema or task subset, an
external harness can adapt rather than make upstream support another MCP.

The recommended integration boundary is deliberately modest:

- AWS's official skill owns installation, local session configuration and
  compatibility guidance. Our independent tool may produce extra app-level
  evidence and export it in a format another evaluator can consume.
- Any actual agent benchmark must use its own **independent task runner**,
  evaluator, time/step budgets, hidden test cases and fraud-resistant scoring.
  Our project-authored sample is transparent, so it is **not** a hidden test.
- Do not execute arbitrary PR code over MCP or run untrusted code on a shared
  AWS session. Reusing a developer's emulator for mutable tasks would require
  state isolation and explicit resource ownership.
- Do not describe locally observed API behavior as real AWS parity, IAM
  security, cloud cost, a production-safe deployment plan or a partnership.

## A narrowly scoped upstream question (not posted)

> We have a small, independent recorded before/after application test on the
> signed local AWS Emulator, with exact source/case hashes, independent AWS
> state readbacks, a failing regression control, and cleanup. This is not an
> AWS-Bench task or an AWS fidelity claim. Would a minimal machine-readable
> task/result contract — emulator version, setup, agent actions,
> postconditions, negative control, cleanup and limitations — help the
> benchmark request? Is there a preferred schema or initial AWS-Bench task
> subset we should align an external harness with?

The connected account currently lacks permission to comment in AWS's
repository; **no upstream comment was posted**. This proposal is meant for
user review or an authorized maintainer conversation, without implying AWS
interest. Measure actual outside-developer adoption separately from public
views, stars or our own test runs.
