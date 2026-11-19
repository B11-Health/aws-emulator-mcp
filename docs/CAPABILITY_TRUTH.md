# Capability Confidence / Gap Radar (offline preview)

**This is evidence navigation, not a new API probe or SDK model scanner.**
This command exists only on the **unmerged experimental** branch
`feat/r4-capability-truth-20261118` (also in the draft Round 4 integration
branch `release/agent-team-preview-r4-20261118`). It is **not** included in
published `v0.4.0-beta.15`, the current `master`, or the Round 3 preview.
For reproducible first use, clone the feature branch and run from its root:

```sh
git clone --depth 1 --branch feat/r4-capability-truth-20261118 https://github.com/B11-Health/aws-emulator-mcp.git aws-emulator-mcp-capability
cd aws-emulator-mcp-capability
node bin/aws-emulator-mcp.mjs capability sts.GetCallerIdentity
node bin/aws-emulator-mcp.mjs capability sqs.SendMessage --json
node bin/aws-emulator-mcp.mjs capability dynamodb.GetItem --json
node bin/aws-emulator-mcp.mjs capability lambda.Invoke --json
```

Each copied command is a separate step: confirm the clone succeeded and that
you are in the intended new checkout before running the next line. Do not
execute Node from an old directory if clone fails. If a future **published**
package includes the feature, the installed equivalent will be
`aws-emulator-mcp capability SERVICE.Operation [--json]`. Do not assume the
currently published beta.15 package provides it.

One exact Botocore SDK identifier (`service.Operation`) is required. The
command reads **fixed repo-owned files only** and returns the SHA-256 of each
source plus its recorded AWS Emulator version. There are no user-selected
snapshot paths, network requests, Docker builds/runs, source imports, AWS
credentials or calls. The versioned SHA-256 pins are repository-maintained
checks against accidental or adversarial JSON changes; **they are not an
independent signature or third-party audit**. Tampering or missing bundle
content fails closed with a nonzero exit instead of upgrading an operation.

## What the three independent answers mean

| Field | Precise meaning |
| --- | --- |
| `sdkModel.status: UNKNOWN` | The current per-operation Botocore catalog is **not** checked. A historical successful SDK operation sets `historicalStatus: modeled_at_recorded_test_time`; this reflects model availability then, **not current** model availability or emulator implementation. The historical *436 modeled services* count is not proof of any operation. |
| `signedEmulatorProbe.status: recorded_responded` | Only one of the exact twenty zero-parameter, read-only calls in `docs/evidence/coverage-aws-emulator-1.0.343.json` returned successfully in a project-maintained test against locally installed signed Emulator **1.0.343**. It does **not** prove the service lifecycle or response fidelity. |
| `appProof.status: verified_recorded_app_case` | The bundled SQS/DynamoDB case on Emulator **1.0.506** has both raw before/after records, source-byte SHA-256 matches, a case hash, a reproduced named regression, passing postcondition checks after the fix, and cleanup. `role` distinguishes calls made by the handler from independent SDK readbacks. One application case is not generic operation compatibility. |
| `UNKNOWN` | The checked-in sources provide no trustworthy evidence for that lane. No evidence is **not** a failure or proof of missing emulator implementation. |

This first index deliberately does **not** promote historical S3 summary-only
comparisons to verified app-level proof because the raw before/after runner
records are absent. Those archived reports remain available separately in
[Proof Workflow](PROOF_WORKFLOW.md). A future contribution can add raw,
recheckable results without broadening an unrelated claim.

### Evidence and scope

- The allowlist is read from `src/aws_emulator_mcp/aws_sdk.py`'s
  `READ_ONLY_PROBES`, and must exactly match the recorded 20-operation set.
- The coverage snapshot is `docs/evidence/coverage-aws-emulator-1.0.343.json`.
- The raw app run is `docs/evidence/app-case-aws-emulator-1.0.506.json`,
  recomputed against `examples/app-case/sqs-idempotency.json`, `buggy.py`, and
  `fixed.py` with the existing `compareAppCaseEvidence` verifier.
- All source hashes and version identifiers appear **in the command output**.
  They describe bundled project-maintained artifacts, **not signed proof
  files**. For current Botocore modeling, use `aws_sdk_discover` in an
  explicitly opted-in local emulator lab. For fresh implementation evidence,
  use `coverage` or reviewed stateful contracts instead.

A passing record never establishes real AWS fidelity, IAM enforcement,
full-service support, user application correctness outside the stated
invariant, package provenance, or an independent adopter benchmark.
