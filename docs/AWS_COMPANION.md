# Work alongside AWS Emulator and the Agent Toolkit for AWS

**Independent community integration; not an AWS product, official skill, partnership, acquisition, or endorsement.**

AWS already provides the emulator, its AI-agent skill, native SDK/CLI setup, compatibility reports and production-facing Agent Toolkit. We should **not duplicate** its installer, cloud credentials, IAM controls, or deployment plane. Developers who only need an AWS SDK test should use the official tools directly.

## Where the pieces belong

| Job | Responsible tool | Boundary |
| --- | --- | --- |
| Install/start/upgrade AWS Emulator, configure local SDK/CLI and assess modeled compatibility | [Official AWS Emulator skill](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-agent.html) | Official skill manages the per-run local endpoint/certificate and checks upstream fidelity; no AWS account for local tests |
| Tell whether an **already started** local AWS Emulator session has a responding HTTPS health endpoint | `aws-emulator-mcp official-session --json` | Read-only loopback request to `127.0.0.1`, validates this run's `ca.pem`; **does not read credentials or execute an SDK call** |
| Reproduce a bounded **application bug** and verify its repair with independent AWS-state assertions | This project's trusted-local `app-case-compare` | Starts **its own** disposable, network-disabled Docker emulator labs; does **not currently reuse** the session that the official skill started |
| Deploy to AWS or inspect production data with AWS IAM permissions and auditing | [Agent Toolkit for AWS / AWS MCP Server](https://docs.aws.amazon.com/agent-toolkit/latest/userguide/) | Separate authorized account, IAM identity and human approval. **Never infer production readiness from an emulator test** |

## Non-disruptive official-session check

After using AWS's official skill to start an emulator, from a current **development checkout** of this repo (not the older beta.15 release):

```sh
# AWS's officially documented installation procedure; not ours:
aws agent-toolkit add-skill --skill-name aws-emulator --region us-east-1
# Ask your coding assistant to start AWS Emulator with the official skill.
# Then independently check an existing loopback session from our CLI:
node bin/aws-emulator-mcp.mjs official-session --json
# For a different localhost port:
node bin/aws-emulator-mcp.mjs official-session --port 9299 --json
```

This command requires Node.js 20+ and a local session created by the official emulator. It **does not require our Docker image**, initiate an installation, start or stop any process, read the per-run AWS credentials, modify the AWS CLI configuration, or call AWS. It loads only the expected session certificate from `~/.aws/emulator/<port>/ca.pem`, with symlink and size checks, and requests `GET https://127.0.0.1:<port>/__admin/health` with TLS verification. It never accepts a remote hostname or user-supplied certificate path.

A healthy result means only that the **local TLS health endpoint returned HTTP 200 with `ok`**; it does **not** prove package provenance, SigV4 identity, the local emulator account, API compatibility or application behavior. After that, **the official skill** should verify `aws sts get-caller-identity` returns account `000000000000` with **its own locally generated** credentials and CA. Follow [AWS's connection and credential-isolation guide](https://docs.aws.amazon.com/emulator/latest/userguide/point-sdk-to-emulator.html). Never reuse real AWS credentials or disable TLS checks.

A missing session is an expected, non-destructive failure (`status: not_configured`, exit 1). Invalid flags exit 2. All JSON outcomes explicitly report `dockerOperationsPerformed: false`, `cloudCallsMade: false`, `credentialFilesRead: false`, `accountIdentityVerified: false`, `applicationBehaviorTested: false`, and `productionAwsValidated: false`.

### Then run a separate, trusted local proof

```sh
node bin/aws-emulator-mcp.mjs app-case-compare \
  examples/app-case/buggy.py examples/app-case/fixed.py \
  examples/app-case/sqs-idempotency.json --json
```

This second command needs a local Docker Engine and builds the signed official emulator package in **separate isolated labs**. It tests only the reviewed sample Python function and its AWS SDK assertions, with cleanup. It does **not** use the first command's existing local emulator instance. Only run Python code you personally own and trust; Docker is not hostile-code isolation. See [the complete application evidence contract](APP_CASE.md).

## An AWS collaboration path rather than a product rivalry

Both official repositories currently decline external code pull requests:

- [AWS Emulator contribution policy](https://github.com/aws/aws-emulator/blob/main/.github/CONTRIBUTING.md): file a reproducible behavior issue or a scoped feature request.
- [Agent Toolkit contribution policy](https://github.com/aws/agent-toolkit-for-aws/blob/main/CONTRIBUTING.md): request features or report bugs, not external code submissions.

**No AWS maintainer has agreed to integrate this project.** A corporate acquisition or merger is speculative. The feasible first collaboration is an independently useful extension with evidence, followed by a maintainer-reviewed feature request if the user approves outreach.

Potential upstream value, with no claims of endorsement:

1. **Agentic app-behavior evaluation:** Submit a sanitized, independent comparison of the exact same trusted Python test before/after a fix, the emulator release, a negative control and cleanup. This is related to [AWS Emulator's DevOps-agent benchmark request](https://github.com/aws/aws-emulator/issues/7), but our fixtures are **not** AWS-Bench tasks and are not evidence of benchmark parity.
2. **Local session interoperability:** Propose a supported, non-sensitive session-discovery/health interface so third-party test tools can recognize a running official instance without duplicating installation. The present `official-session` command is a first **read-only** probe, not a shared backend.
3. **Machine-readable fidelity escalation:** Feed exact observed SDK operations and sanitized reproductions to AWS's existing issue templates. Never file a fidelity bug on the basis of a missing application assertion alone; confirm an actual emulator-vs-AWS behavior difference before making that claim.

The next technical milestone is **optional reuse of an independently verified official local emulator** for safe, explicitly selected SDK operations, with correctly scoped credentials and no access to user AWS accounts. It must retain the current trusted-source restriction, protect against remote endpoint injection, verify the emulator account using the official SDK configuration, and separately isolate stateful tests. **No automatic adoption, account connection or production deployment.**

### What would make the collaboration credible?

- A developer outside the maintainer team runs one sample and one owned application test with **no AWS account**, recording the exact setup path and outcome.
- The same invariant detects a deliberate failure and a verified fix, with a clean-up check and emulator version recorded.
- Tests distinguish **official emulator limitations** from application bugs, and never turn AWS model availability into a broad coverage claim.
- Reviewers can consume an optional, sanitized, versioned proof artifact without installing our entire MCP.

**We have not contacted AWS or submitted an upstream issue on behalf of this project.** Request review of a focused proposal only after the independent use case and interop boundary are confirmed.
