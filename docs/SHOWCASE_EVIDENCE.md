# Demo studio: evidence ledger and limitations

The [interactive demo studio](https://b11-health.github.io/aws-emulator-mcp/) and [87-second narrated video](assets/demos/proof-first-beta15.mp4) explain **AWS Emulator MCP v0.4.0-beta.15**. This page separates actual execution from illustrative visuals.

## What was actually run

| Scene | Test or review | Grounded outcome | Reproducible source |
| --- | --- | --- | --- |
| 1. Why MCP | Description of reviewed product workflows, not a benchmark | 38 curated tools exposed by the signed-emulator Docker suite | [Hosted integration CI](https://github.com/B11-Health/aws-emulator-mcp/actions/runs/44102711476) |
| 2. First run | Real Node CLI invocation on a maintainer-controlled Windows machine | Exit 0; 7 generated artifacts, 3 resource types, 14 synthetic plan steps **not executed**, zero Docker/cloud calls | [Sanitized trial output](evidence/showcase-offline-trial-beta15.json); [generator source](../scripts/offline_trial.mjs) |
| 3. Duplicated order | Reviewed order-intake implementation against emulated DynamoDB/S3/SQS APIs | Broken: 2 accepted submissions and 2 SQS messages. Fixed: 1 accepted and 1 SQS message; scoped cleanup checked | [Application debugging methodology](APP_DEBUGGING.md); [saved sample evidence](evidence/app-debug-aws-emulator-1.0.365.json) |
| 4. Missing receipt | Synthetic S3 **pre-call** RequestTimeout, after an emulated DynamoDB order write | Fragile handler: missing receipt/event. Recovered handler: receipt restored and one SQS event. The CI run includes **PARTIAL_WRITE_MCP_PASS** | [Failure Lab methods](FAILURE_LAB.md); [beta.15 CI](https://github.com/B11-Health/aws-emulator-mcp/actions/runs/44102711476) |
| 5. BYOA | Explicit local CLI runs two developer-selected **trusted** Python order handlers in isolated labs | Reproduced baseline and passing fix required; hashes, assertions and cleanup are included in output | [Handler comparison methodology](BYO_HANDLER.md); [example code](../examples/byo-order-handler/) |
| 6. PR review | Read-only comparison of two checked-in architecture manifests | Example DynamoDB partition-key change orderId to orderRef is flagged for human review; no AWS call | [Architecture Review docs](ARCHITECTURE_REVIEW.md); [before and after](../examples/architecture/review/) |
| 7. Connect agent | Actual CLI prints editor-specific stdio configuration on Windows | No Docker required to *print* configuration. Docker is required for live emulator-backed tools | [Setup guide](ONBOARDING.md) |
| 8. CI results | Three passing GitHub PR workflows on the versioned beta.15 source tree | Quality gates (7 jobs), architecture consumer and contract consumer passed; signed AWS Emulator **1.0.491**. Docker logs include **DOCKER_SDK_PASS** and **DOCKER_SOURCE_IDENTITY_PASS** | [Quality run 44102711476](https://github.com/B11-Health/aws-emulator-mcp/actions/runs/44102711476), [contract run](https://github.com/B11-Health/aws-emulator-mcp/actions/runs/44102711336), [architecture run](https://github.com/B11-Health/aws-emulator-mcp/actions/runs/44102711298) |

The separate [Windows preflight output](evidence/showcase-no-docker-preflight-beta15.json) shows that Docker was *not installed* on the maintainer-controlled Windows machine. Its expected nonzero exit is a useful, honest demonstration of prerequisite detection, not a successful emulator launch. The offline trial works in this environment.

## Important trust boundaries

- The narrated video is an **edited explainer**, assembled from verified command results and documented synthetic scenarios. It is **not a continuous terminal screen recording** or an unscripted AI-patch session.
- The video has a human-readable [transcript](SHOWCASE_TRANSCRIPT.md) and a [WebVTT captions track](assets/demos/proof-first-beta15.vtt). Narration is locally synthesized from the transcript; no copyrighted music or third-party recording is used.
- **Synthetic fault injection** at the SDK boundary is not a real S3 outage, process kill or evidence of transactional atomicity.
- **Offline generation** proves generated-file structure/integrity, not actual AWS API behavior.
- **Architecture review** compares local source blueprints, not live CloudFormation change sets or deployed infrastructure.
- **IAM policies are not enforced like production AWS** by the emulator. No local check proves general AWS parity, security compliance or correct production IAM authorization.
- **User-provided Python** is allowed only as an explicit trusted-local CLI action. Never run untrusted pull-request code this way; Docker is not a secure sandbox for adversarial code.
- These are **project-maintained QA runs**, not independent outside-user adoption or a security certification.

## Run it yourself, in stages

**Offline: Node.js 20+ and Git**

~~~bash
git clone --depth 1 --branch v0.4.0-beta.15 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs try --json
node bin/aws-emulator-mcp.mjs architecture demo
~~~

**Optional real emulator APIs: requires local Docker, Linux containers and sufficient disk**

~~~bash
node bin/aws-emulator-mcp.mjs preflight --json
node bin/aws-emulator-mcp.mjs doctor
node bin/aws-emulator-mcp.mjs app-debug compare --json
node bin/aws-emulator-mcp.mjs failure-lab partial-compare --json
node bin/aws-emulator-mcp.mjs app-compare examples/byo-order-handler/buggy.py examples/byo-order-handler/fixed.py --markdown
~~~

The trial comes first because the first emulator build downloads a sizable signed Linux image. Use the pinned release and do not supply production secrets or private customer data.

**What feedback matters?** Report the operating system, the exact reviewed command, a synthetic assertion that differed, and whether cleanup passed. See the [short field report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml). Negative experience is valuable.
