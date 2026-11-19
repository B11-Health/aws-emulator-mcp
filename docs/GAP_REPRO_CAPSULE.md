# Emulator Gap Reproduction Capsule — offline triage export

When your **trusted Python application** fails a reviewed local AWS Emulator
`app-case` test, you can prepare a portable, **redacted JSON issue-triage
capsule** without executing source again. This export is independent of the
existing before/after Markdown and agent evaluation handoff: it answers what
SDK operation was observed, which independent assertion failed, and what a
maintainer needs to request before attempting a local replay.

From the **source checkout root**, with an existing failed report saved as
`./failed-report.json`, use an **unused local output filename** and check the
exit status before sharing the file. The capsule is UTF-8 JSON, but its own
file bytes are **not** used to validate the source/case hashes inside it.

**Bash / zsh** (redirects native stdout to a local file):

```sh
node "./bin/aws-emulator-mcp.mjs" gap-capsule "./failed-report.json" > "./issue-capsule.json"
# Check that the command exited 0 before trusting or sharing the result.
```

**PowerShell 7+ only**, explicitly write UTF-8 **without a BOM**, and never
save the output when the CLI fails:

```powershell
$report = & node ".\bin\aws-emulator-mcp.mjs" gap-capsule ".\failed-report.json"
if ($LASTEXITCODE -ne 0) { throw "gap-capsule failed; no output was saved" }
$report | Set-Content -LiteralPath ".\issue-capsule.json" -Encoding utf8NoBOM
Get-Content -LiteralPath ".\issue-capsule.json" -Raw -Encoding utf8 | ConvertFrom-Json | Out-Null
```

**Do not use `>` or `Out-File` with Windows PowerShell 5.1** to produce the
JSON capsule: its default output encoding is **UTF-16LE**, not UTF-8. Use
PowerShell **7+** as shown, or a JSON editor configured to save UTF-8.
PowerShell may normalize line endings; do **not** claim byte-for-byte identity
between its output file and the CLI's stdout. The report's source/case
SHA-256 values are copied from the input evidence and are **not** fresh
checksums of this export or an attestation of the original files.

The input is a **local regular JSON report** (maximum 256 KiB, not a symlink),
not a Python script or case definition. Supported inputs:

- A failed standalone `app-case --json` output (`schemaVersion: 1`).
- A before/after `app-case-compare --json` summary (`mode: local_application_before_after`).
- A failed developer-approved `app-guide --run --approve ... --json` result (`mode: approved_trusted_app_case`).

For a recorded evidence wrapper with a `before` / `comparison` member, first
extract the **existing** report object as JSON through a local editor, then
pass that standalone object to `gap-capsule`. The command never runs Docker,
imports developer code, contacts AWS, reads cloud credentials, or installs
software. Its only input is the selected JSON report; it only prints JSON to
stdout. Invalid, missing, inconsistent or overlarge input exits with code 2
and **no capsule**. No external URLs, UNC shares, or device paths are allowed.

## What maintainers receive

| Capsule field | Meaning / limitation |
| --- | --- |
| `target.handlerOperation` | An allowlisted *observed* `service.Operation`, if unambiguous; `null` otherwise |
| `target.independentReadOperation` | The failing independent read, when its operation is present in the input |
| `target.failedAssertions` | Assertion position, safe path shape and pass/fail only — no expected values or private field names |
| `target.observedSdkCalls` | Allowlisted operation names and bounded attempt/success counters |
| `identities.sourceSha256`, `caseSha256` | Reported source/case identities, **not** a fresh hash of the original files |
| `emulator.version` | Strictly formatted version **reported by the input**; not independently re-attested |
| `emulator.accountVerifiedInReport` | `true` only if raw/compare input explicitly reported verified; `not_reported` for guided evidence |
| `interpretation.classification` | A triage category, **never** automatic emulator attribution |
| `reproduction.runCommandTemplate` | Checkout-relative command structure, with placeholder files and an explicit approval step where required |

For a raw failing result, the replay command remains opt-in through
`app-guide --run --approve` and requires a fresh source+case approval token.
For a before/after report, the template uses `app-case-compare` with separate
trusted `before` and `after` source revisions. The capsule supplies matching
SHA-256 identities but **cannot supply source files or a case JSON**; the
maintainer must obtain reviewed synthetic attachments and replace the filename
placeholders. Therefore the command is a precise local *template*, not a
promise that unprovided inputs can be reproduced automatically.

The exporter checks expected-call attempt counts against the observed SDK
calls. For raw reports it additionally reconciles `min`, `max` and `passed`;
comparison and guided summaries do **not** contain those original ranges, so
it cannot reconstruct or independently attest them. A passing expected-call
**attempt count** does not mean the SDK operation succeeded: zero successful
calls are permitted in a deliberate, failed before-call fault baseline but
cannot support a green fixed-app result or a guided successful-operations
claim. For a demonstrated before/after regression, both summaries must
preserve the **same ordered independent check IDs and assertion paths**; the
named failed before-side assertion must exist and pass after the fix. A
zero-success before-side operation is acceptable only when matching,
internally consistent **injected before-call fault metadata** appears in the
comparison, with the same fault configuration on both revisions. Removing or
contradicting that evidence fails closed. Such checks detect contradictory
report fields; they do **not** independently attest the injected fault,
source bytes, emulator identity or AWS production behavior. Conflicting
assertion and handler services are left unattributed.

A reported failure may be caused by application logic, incorrect assumptions,
unsupported emulator behavior, setup failure, or test design. A passing
before/after application correction is classified as application regression
in the recorded report, **not** as emulator incompatibility. Even an
unexplained failed SDK read is only a candidate for triage. The export never
asserts AWS production parity, IAM equivalence, confirmed emulator bugs,
independent signing, or a verified STS identity when one was not reported.

## Privacy and upstream issue readiness

The exporter uses a fixed output allowlist. It discards raw file paths, case
names, SDK parameters, bodies, response values, exception messages, local
logs, credentials, custom assertion names, user-defined keys, and unrelated
report metadata. Unknown attribute paths become `<redacted-assertion-path>`.
Only SHA-256 identities of the **source and case files** remain, plus the
strictly shaped emulator version and safe test structure. Review even this
minimal metadata before publicly filing an issue.

Useful upstream issue title: *Possible local emulator mismatch in reviewed
`service.Operation` test — reproduction capsule attached*. Include the
capsule and the **separately reviewed synthetic reproducer** (not real
customer data). Ask maintainers to rerun the independent state assertion.
A capsule without those attachments is a triage record, not a fully runnable
self-contained reproducer.
