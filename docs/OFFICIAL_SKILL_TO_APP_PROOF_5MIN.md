# Five-minute hands-on: official AWS Emulator skill → independent app proof

**Goal:** find out whether *your AWS-backed application's behavior* changed after a fix, rather than merely whether an SDK request succeeded.

**Timebox:** five minutes **after** prerequisites, skill installation and a usable local Docker emulator image are ready. A fresh AWS CLI, agent setup, emulator download/build or slow computer can take substantially longer. This is a **draft preview checkout**, not the tagged `v0.4.0-beta.15` release.

**Complementary, not official:** AWS maintains the [AWS Emulator agent skill](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-agent.html), SDK connection and [project fidelity checks](https://docs.aws.amazon.com/emulator/latest/userguide/check-project.html). B11-Health's independent MCP adapter adds a *separate* trusted-local Python before/after test with independent AWS-state assertions. **The two emulators do not share a session or test state.** Neither establishes production AWS IAM, complete application correctness or AWS compatibility.

## Before starting

- **Official path:** compatible local AI coding agent (for example Kiro, Cursor or Claude Code), **AWS CLI 2.35.0+**, the official `aws-emulator` skill and internet for its initial installation. Let AWS's [setup guide](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-agent.html) own the installation; review requests to edit local profiles or system packages.
- **Independent application proof:** Git, **Node.js 20+**, local Docker Engine/Desktop in **Linux-container mode**, a cached verified emulator image (or sufficient disk/network to build it), and reviewed sample Python source. Optional source inspection requires host Python 3.10+.
- **No AWS account or production credentials for the local examples.** Never use a production profile, customer payload or untrusted PR source. The official skill can download public assets; that is distinct from calling your real AWS account. Docker is not a sandbox for hostile code.

Each shell command below is **one line**, usable in a terminal or PowerShell. Run our repository commands in a separate terminal.

## 0:00–1:00 — Use the official skill for installation and compatibility

AWS documents these commands (version must be **2.35.0 or later**):

~~~sh
aws --version
aws agent-toolkit add-skill --skill-name aws-emulator --region us-east-1
~~~

If your AWS CLI is older, or the second command is unavailable, **stop** and follow the [official guide](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-agent.html). This document does not provide an unofficial replacement installer.

In the **compatible local coding agent**, ask:

> Use the official aws-emulator skill to install/start AWS Emulator locally. Point only synthetic SDK/CLI test calls at its locally generated endpoint, credentials and CA. Check the S3, DynamoDB and SQS operations used by this sample against official fidelity information. Show unsupported or untested behaviors. Ask before editing configuration outside this project. Do not access my AWS account or deploy anything.

**Pass condition:** the official skill has an actual localhost session and a scoped compatibility report. That is **not** yet proof the Python application is correct. Don't assume an agent installed the skill if it has not reported success.

## 1:00–2:00 — Check the independent handoff without AWS credentials

The commands below exist in [draft integration PR #74](https://github.com/B11-Health/aws-emulator-mcp/pull/74), on the `release/agent-team-preview-20261118` branch. They are **not in the published beta.15 release**:

~~~sh
git clone --depth 1 --branch release/agent-team-preview-20261118 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs onboard --offline --json
node bin/aws-emulator-mcp.mjs official-session --json
~~~

`onboard --offline` validates **seven generated architecture artifacts** and checksums. Look for `firstWin.passed: true`, `firstWin.artifactCount: 7`, `firstWin.contractExecuted: false`, `readiness.dockerProbePerformed: false` and `safety.noCloudCalls: true`. The synthetic 14-step plan is **not executed**; no source, Docker containers, AWS credentials or cloud APIs are used.

`official-session` makes a **read-only localhost HTTPS health request** using the official session's local CA. `localHealthPassed: true` means the TLS health endpoint responded; **not** account identity, signed-package provenance, application behavior or AWS fidelity. `status: not_configured` with exit code **1** is an expected, honest outcome when no matching official session exists (or it uses another port). The probe never attaches our app test to that session or reads its credential files. Do not disable TLS validation. See [official-session limits](AWS_COMPANION.md#non-disruptive-official-session-check).

## 2:00–4:00 — Prove one application regression using independent SDK reads

Before executing any Python, review the [deliberately broken source](../examples/app-case/buggy.py), [corrected source](../examples/app-case/fixed.py), and their [single reviewed JSON case](../examples/app-case/sqs-idempotency.json). The test calls a trusted sample function **twice with the same order**. The invariant is **one** fulfillment message, even when the request repeats.

Read-only inspection and readiness checks:

~~~sh
node bin/aws-emulator-mcp.mjs app-case-inspect examples/app-case/fixed.py examples/app-case/sqs-idempotency.json --json
node bin/aws-emulator-mcp.mjs preflight --json
~~~

The inspector should report `executedSource: false`, `executedAWSCalls: false` and a non-runnable *suggested* starter case. The independently authored sample case above is a different, reviewed file. If Docker is not ready or its cached image fingerprint is stale, **stop** and follow [first-run requirements](FIRST_RUN.md) before running the next step. Do not auto-prune Docker or quietly rebuild a large image.

After reviewing the bundled source and confirming local Docker readiness, explicitly run:

~~~sh
node bin/aws-emulator-mcp.mjs app-case-compare examples/app-case/buggy.py examples/app-case/fixed.py examples/app-case/sqs-idempotency.json --json
~~~

This starts **two separate isolated local Docker labs**, not the official skill's running instance. The local, trusted Python source executes and the test harness **independently reads DynamoDB and SQS state**. The broken version must fail **only** `receive.Messages.1` because the second queue message exists. The corrected version must pass the **same** assertion. A function return flag cannot force that readback to pass.

## 4:00–5:00 — Interpret the complete result, not just its exit code

Require `passed: true`, `bugReproduced: true`, `fixVerified: true`, `applicationBehaviorTested: true` and `productionAwsValidated: false`. Confirm equal `caseSha256`, **different** before/after source hashes, one named before failure, after assertions all passing and **both** `cleanupPassed: true`. SDK call counts explain how the bug manifested but **independent state assertions** determine the result.

The [project-maintained, historical AWS Emulator 1.0.506 record](evidence/app-case-aws-emulator-1.0.506.json) records these results; your signed emulator version and output can differ:

| Observation from separate local runs | Buggy | Corrected |
| --- | --- | --- |
| Successful application SQS `SendMessage` calls | 2 | 1 |
| Independent state assertions passing | 3/4 | 4/4 |
| `receive.Messages.1` (second event must not exist) | **FAIL** | **PASS** |
| Scoped cleanup | **PASS** | **PASS** |

An unrelated error, changed case, missing app invocation, stale image, or incomplete cleanup **does not prove a fix**. Do not infer production AWS security/IAM, full API fidelity, distributed transaction correctness or process-crash safety. [Complete application evidence contract](APP_CASE.md#evidence-interpretation) · [Draft-only Proof Explorer source](proof-explorer.html) (not yet deployed at the public Pages URL).

## Bring your own handler — separate adoption test, not a five-minute promise

Follow the existing [guided bring-your-own-Python workflow](GUIDED_APP_PROOF.md): choose your own trusted, self-contained `handle(clients, inputs)` function, inspect without executing source, author *independent synthetic state checks and cleanup*, review source and case hashes, and opt into one trusted-local Docker run. A green run by itself is not a verified fix; compare the **same invariant** against an expected-red baseline and corrected source. Never execute untrusted PR code or expose arbitrary source execution to MCP.

If the official skill and direct AWS SDK/CLI tests already answer your question, **you may not need this adapter**. AWS's official fidelity assessment remains the reference for tested emulator-versus-AWS behavior; our proof concerns *one application invariant within the local emulator*.

## Independent adoption measurements (proposals, zero external results so far)

Include **all starts**, including failures and abandoned attempts, in each denominator. Participants must opt in and share only redacted evidence, never credentials or private source. Segment by operating system, AWS CLI/Node/Docker versions and whether an emulator image was already cached.

| Cohort | Observe | Proposed decision threshold |
| --- | --- | --- |
| **First use (10 independent newcomers)** | Time from checkout to `onboard --offline --json` exit 0 and correct recognition that zero AWS APIs ran | ≥8/10 complete unaided within five minutes **after Node/Git setup** |
| **Official skill handoff (5 independent developers)** | Skill actually installed/used, local session health outcome, understanding that official session and our two app labs are distinct | ≥4/5 correctly explain the ownership boundary |
| **Bring-your-own-app (5 independent developers)** | A meaningful expected-red/verified-green invariant on identical case hash; distinct source hashes, independent SDK assertions, both cleanups | ≥3/5 finish within 30 minutes **after Docker image readiness**; report API gaps separately |

**Not adoption evidence:** internal CI, saved maintainer test snapshots, repository stars, draft PR reactions, page impressions or an unapproved AWS article. [Voluntary redacted first-run report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=independent_first_run.yml) · [field report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml).

## Official contribution and benchmark boundaries

AWS Emulator's [contribution policy](https://github.com/aws/aws-emulator/blob/main/.github/CONTRIBUTING.md) asks for **issues rather than external code PRs**. Its [benchmark request #7](https://github.com/aws/aws-emulator/issues/7) concerns possible local DevOps-agent benchmark support, **not** an AWS agreement, AWS-Bench compatibility or endorsement. [Our PR #73](https://github.com/B11-Health/aws-emulator-mcp/pull/73) already owns the evaluation-handoff fixture and AWS Builder article **draft**. This guide neither duplicates nor submits them. **No AWS/community outreach or public posting is implied or authorized.**
