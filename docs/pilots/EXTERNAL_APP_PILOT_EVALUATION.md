# External application pilot evaluation protocol

**Status: prepared; no independent participant run or result is recorded here.**
This is a maintainer protocol for a future, consenting developer trying their
**own trusted, self-contained Python handler**. Use the
[participant guide](../EXTERNAL_APP_PILOT.md) for the short product flow and the
[guided application proof](../GUIDED_APP_PROOF.md) for an own-handler task.

## Keep the two kinds of run separate

| Run kind | What can be established | What cannot be claimed |
| --- | --- | --- |
| `MAINTAINED_REHEARSAL` | The supplied Unicode receipt fixture can be inspected and, if deliberately executed, compared from files outside the MCP checkout. | An independent developer used their own application, outside adoption, or production AWS parity. |
| `EXTERNAL_OWN_HANDLER` | A consenting developer attempted a bounded case for a handler they own and trust; record the actual outcome and assistance. | Full-project coverage, production AWS parity, repeat use, or adoption from a single session. |

The [maintained receipt fixture](../../examples/external-app-pilot/README.md)
uses an ASCII-loss before revision, a UTF-8 after revision, and one independent
`HeadObject.ContentLength` assertion. Moving this fixture to another directory
does not make it independently owned source. Never pool its results with
external starts. Record any rehearsal or prior exposure before an own-handler
task; show those participants separately from first exposure.

## Participant agreement and bounded scope

Before the first task action, explain the task, expected duration, local
execution boundary, optional assistance, and intended reporting. Obtain
separate agreement to participate, retain an anonymous started/outcome count,
and share any reviewed evidence. The participant can stop or decline sharing
at any point. Agree a deletion/retention rule before starting; if permission is
later revoked, honor it and disclose permitted aggregate exclusions rather than
silently improving the denominator. No names, email addresses, employer names,
or private project identifiers belong in the results file.

Use a reviewed checkout pinned to a commit containing the required commands;
record that commit and the emulator version. Do not imply the draft workflow
is available in a published package. Prerequisites are Node.js 20+, host Python
3.10+ for static inspection, and a suitable local Linux-container Docker engine
and verified matching emulator image for execution. Separate preflight from a
deliberate build; inspection and draft creation do not need a build.

The selected source must be an owned, trusted, regular UTF-8 `.py` file,
at most 20 KiB, with a self-contained `handle(clients, inputs)` entrypoint (or
an explicitly selected supported entrypoint). Keep the selected source and case in a participant-controlled directory
outside the MCP checkout. Use injected clients and synthetic inputs. This is not an arbitrary repository, dependency-installation, or pytest
runner. Static discovery has limits with aliases, dynamic client names, sibling
imports, and runtime control flow. A participant-authored adapter is permitted,
but include its preparation time and describe the evaluated subset without
sharing source. An unsupported original application remains a scope finding.

The separately reviewed, regular JSON case is at most 48 KiB. It declares
fresh owned fixtures, setup, invocation and SDK-count expectations, independent
state reads, and cleanup. See [case requirements and limits](../APP_CASE.md).
No production accounts, real AWS credentials, customer data, untrusted PR code,
or broad scans of the participant's repository are needed. Docker is not a
safe way to execute hostile source. The participant retains source and raw
reports locally and controls every execution decision.

## Short task

1. Select the owned handler and state one concrete expected AWS-side effect.
   Explain the invariant before seeing a successful result.
2. Inspect the selected file without executing it. Author and review a case
   with synthetic inputs, fresh owned resources, appropriate SDK counts, an
   independent read of the effect, and scoped cleanup.
3. Review local readiness and the exact source/case, then deliberately execute
   the supported workflow. Follow its documented approval steps where used.
4. Read the evidence and explain whether it supports the chosen invariant.
   Optionally compare a genuine before/after source pair against the **same**
   reviewed case. Share only the agreed, manually sanitized result.

A maintainer may answer questions using the assistance rubric below. Do not
substitute the maintained receipt source when an own-handler task is blocked
and then count it as an external success. A generated incomplete draft needs
human review. An inverted expected-red case tests assertion sensitivity; it
does not establish a bug fix. A real defect is not required for a state-proof
task, and no defect should be manufactured to qualify.

## Start ledger, clocks, and assistance

Create one anonymous ledger row when consent is complete and the participant
begins eligibility review, setup, or the first task action. This is a **start**,
including when the first action reveals an unsupported application. Use one row
per participant's first task in a cohort; retries and revisions are attempts
within that row. Record every start, including setup blocks, unsupported scope,
abandonment, time limits, and runs without shareable evidence. Invitations and
declined participation are not starts. A replaced or excluded participant must
not disappear from reported counts.

Use wall-clock time in seconds, measured manually. Do not pause clocks for
downloads, builds, reading, debugging, help, retries, or waiting for the tool.

| Clock | Start | Stop and interpretation |
| --- | --- | --- |
| Fresh setup | First consented action, with the environment classified `FRESH` or `PREPARED`. | When the pinned CLI, inspection requirements, local Docker readiness, and matching image are ready, or the session stops. Record whether setup completed. A prepared environment is a separate stratum, not a fresh-setup observation. |
| Application proof | Immediately after readiness, when the own-handler task begins. | First qualifying proof, or the participant stops/reaches the agreed time limit. Include source selection, any adapter, case authoring, review, execution, and retries. Leave duration null if this stage never starts. |
| Total session | First consented action. | Session end. Include interruptions; record interruption codes and incomplete status. Report incomplete elapsed times as such, not as time-to-success. |

Agree a maximum session duration before the first cohort and use it consistently.
Record whether optional rehearsal happened before the session; if performed
during it, include that time in the total and mark prior exposure. For a fresh
participant, setup cost must remain visible even if the proof clock is short.
Do not convert unknown or unfinished measurements into zero.

| Highest assistance level | Definition |
| --- | --- |
| `L0` | Participant uses the supplied documentation without human help. |
| `L1` | Maintainer points to existing documentation or clarifies generic setup/command usage; no application-specific invariant, case, or source advice. |
| `L2` | Maintainer suggests an application-specific assertion, SDK operation, adapter approach, or diagnosis. Record as assisted. |
| `L3` | Maintainer authors/edits source, adapter, case, or assertion, or operates the task for the participant. Record as maintainer-led. |

Record the highest level reached, not only the level at completion, and brief
sanitized action codes such as `DOC_POINTER`, `SETUP_HELP`,
`ASSERTION_HINT`, `CASE_EDIT`, `SOURCE_EDIT`, or `OPERATOR_EXECUTION`.
A maintainer-authored assertion is never independent completion. Source ownership and completion independence are separate facts.

## Outcome gates

Record `STATE_PROOF` only when the selected owned handler actually ran, expected
SDK call counts matched and required operations succeeded, an independent
SDK state read matched a meaningful invariant, fresh owned fixtures
were used, and declared cleanup completed. A return value, static approval,
call attempt alone, or resource-presence check that misses the claimed behavior
is insufficient. The participant must be able to explain the assertion and the
limited conclusion. Missing evidence is not a pass.

Record `FIX_PROOF` only when the additional
[comparison requirements](../APP_CASE.md#evidence-interpretation) hold: different
verified source hashes; one unchanged case hash; matching emulator versions;
the before source fails only the named regression assertion with other evidence
valid; the after source passes; and both runs clean up. Unrelated API, startup,
source, or cleanup failures do not reproduce the bug. A verified fix is also a
state proof, not a second participant completion.

Use `REHEARSAL_ONLY` for a completed maintained-fixture task and `NO_PROOF`
for a started task without either external proof. A qualified external completion
requires `EXTERNAL_OWN_HANDLER`, confirmed ownership/trust, source outside the MCP checkout, and evidence above.
Report `L0`/`L1` completion separately from assisted `L2`/`L3` completion.
All emulator evidence remains bounded; `productionAwsValidated` must be false
in an executed report.

Attach one or more failure/stop codes when relevant; successful retries may
still retain earlier failure codes.

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_SCOPE` | Selected source/workflow cannot fit the supported bounded interface. |
| `SETUP_BLOCKED` | CLI, Python, Docker, image, disk, or local readiness prevents progress. |
| `INSPECTION_OR_CASE_BLOCKED` | Static review, schema validation, stale approval, or case authoring is unresolved. |
| `EXECUTION_BLOCKED` | Source exception, timeout, identity/runner failure, or unexpected SDK error. |
| `ASSERTION_FAILED` | Reviewed independent state invariant failed; not automatically an emulator defect. |
| `CLEANUP_FAILED` | Declared cleanup did not complete; completion gate fails. |
| `EVIDENCE_INCOMPLETE` | Invocation, successful writes, invariant, comparison, or cleanup cannot be established. |
| `TIME_LIMIT` | Agreed session limit reached before qualifying completion. |
| `ABANDONED` | Participant voluntarily ended the task; no explanation is required. |
| `WITHDRAWN` | Participation/evidence permission withdrawn; apply the agreed retention rule. |

Do not diagnose an emulator gap from a code alone. If the participant wants
further triage, use the separately reviewed [offline capsule workflow](../GAP_REPRO_CAPSULE.md);
that is optional and does not authorize an upload or issue.

## Minimal evidence and reporting

**No automated collection, telemetry, uploads, screen recording, or source
submission is part of this protocol.** The participant manually reviews each
shared field. Default to aggregate observations; do not request a raw report.

Allowed, only with agreement: anonymous participant code; run kind and prior
exposure; pinned tool commit and emulator/runtime versions; coarse OS family;
fresh/prepared status; consent/start/completion flags; elapsed seconds;
assistance/action codes; sanitized outcome/failure codes; expected/observed SDK
attempt and success counts; independent-assertion and cleanup pass/fail facts;
and optional source/case hashes after specific review. Hashes can link records
and are not a source-safety guarantee. Use generic assertion labels; keep
payload values and private case labels out.

Exclude identities, company/project names, source, source or report paths,
credentials/tokens, endpoints, account identifiers, real resource names, raw
inputs/outputs, stack traces, application logs, screenshots, and free-text
feedback that accidentally contains these. Redaction is manual, even where
the CLI already omits sensitive fields. Stop sharing when sanitization is
uncertain; a known start can still be reported as having no shareable evidence.

Copy the [unused results template](external-app-pilot-results-template.json)
per consented start. It is an observation record, not a runnable app case or
validated report schema. `NOT_RUN` and null values explicitly mean no
measurement. Change status to `IN_PROGRESS`, then `COMPLETE` or `STOPPED`
as appropriate; preserve null for unknown/not-reached fields. Fill evidence
from reviewed reports, never from expected fixture behavior. SDK-count rows
may contain only service, operation, expected minimum/maximum, and observed
attempt/success counts. Never commit participant records or hashes to this public repository by default.

For an initial small pilot, **proposed targets, not observations**: enroll five
consecutive external starts; aim for at least three `L0`/`L1` own-handler
state proofs within 30 minutes of application-proof start. Report the actual
numerator over **all external starts**, including unsupported and abandoned
tasks, plus assisted completions and the failure-code breakdown. Report setup
and proof times separately, with fresh/prepared and prior-exposure counts.
Show individual anonymized durations or a range for such a small cohort; do
not present successful-run-only timing as the whole experience. Report optional
fix proofs separately without double-counting completions.

These targets are a proposed usability gate. Rehearsals, an empty template,
a small convenience sample, and one green case establish no completion rate
until observed, and no independent adoption or production fidelity claim.
