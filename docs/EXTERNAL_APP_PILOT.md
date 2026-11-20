# First run: a receipt app outside the MCP checkout

This is **maintained external-workspace pilot preparation**. You copy a small
synthetic app into a separate directory, inspect it without execution, then
explicitly compare two trusted revisions against one reviewed invariant. It
is a rehearsal of the workflow, not evidence of independent developer adoption. The
[recorded Linux maintainer comparison](../examples/external-app-pilot/README.md#recorded-maintained-rehearsal)
shows one completed run and its exact evidence boundaries.

Use a reviewed **source preview containing `examples/external-app-pilot/` and
this guide**. These files are not in published beta.15 or the earlier R4 base
commit alone. Record the preview's exact Git commit before starting. The
[fixture README](../examples/external-app-pilot/README.md) explains the app;
[APP_CASE.md](APP_CASE.md) defines the runner and case format.

Requirements: Node.js 20+, host Python 3.10+, and a local filesystem. Actual
execution additionally needs local Docker with Linux containers and sufficient
space for the verified signed emulator image. No AWS account or credentials
are needed. This runner selects one self-contained `handle(clients, inputs)`;
it does not install application dependencies or import sibling project files.
Use only source you personally trust. The lab is not a hostile-code sandbox.

## 1. Create a fresh external workspace

Start in the reviewed MCP source checkout root. Choose **one** shell below
and keep that session open so its path variables remain available. Both
examples create the sibling directory `external receipt pilot`, with spaces
in its name, and change into it. Creation must fail if that destination already
exists; choose a different fresh name instead of overwriting existing work.
Stop if any command fails. A partial staging attempt is not ready for Step 2.

**Bash**

```bash
git rev-parse HEAD
REPO="$(pwd -P)"
CLI="$REPO/bin/aws-emulator-mcp.mjs"
FIXTURE="$REPO/examples/external-app-pilot"
PILOT="$(dirname "$REPO")/external receipt pilot"
if [ ! -f "$CLI" ] || [ ! -f "$FIXTURE/receipt-case.json" ]; then
  printf '%s\n' 'Start in the source preview checkout containing the pilot.' >&2
  false
else
  mkdir "$PILOT" &&
  mkdir "$PILOT/before" "$PILOT/after" &&
  cp "$FIXTURE/before/receipt_handler.py" "$PILOT/before/receipt_handler.py" &&
  cp "$FIXTURE/after/receipt_handler.py" "$PILOT/after/receipt_handler.py" &&
  cp "$FIXTURE/receipt-case.json" "$PILOT/receipt-case.json" &&
  cd "$PILOT"
fi
```

**Windows PowerShell**

```powershell
$ErrorActionPreference = 'Stop'
git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Use the reviewed Git source preview.' }
$Repo = (Get-Location).ProviderPath
$Cli = Join-Path $Repo 'bin/aws-emulator-mcp.mjs'
$Fixture = Join-Path $Repo 'examples/external-app-pilot'
$Pilot = Join-Path (Split-Path -Parent $Repo) 'external receipt pilot'
if (!(Test-Path -LiteralPath $Cli -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $Fixture 'receipt-case.json') -PathType Leaf)) { throw 'Start in the source preview checkout containing the pilot.' }
if (Test-Path -LiteralPath $Pilot) { throw 'Destination exists; choose a fresh directory.' }
New-Item -ItemType Directory -Path $Pilot | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Pilot 'before'), (Join-Path $Pilot 'after') | Out-Null
[IO.File]::Copy((Join-Path $Fixture 'before/receipt_handler.py'), (Join-Path $Pilot 'before/receipt_handler.py'), $false)
[IO.File]::Copy((Join-Path $Fixture 'after/receipt_handler.py'), (Join-Path $Pilot 'after/receipt_handler.py'), $false)
[IO.File]::Copy((Join-Path $Fixture 'receipt-case.json'), (Join-Path $Pilot 'receipt-case.json'), $false)
Set-Location -LiteralPath $Pilot
```

All subsequent CLI and selected-file paths are absolute. The copied files are
ordinary local files outside the MCP checkout, with no directory mounted into
the eventual lab. Local drive paths are supported; UNC shares, Windows device
paths, URLs and symlinked selected files are refused by the CLI.

## 2. Read and inspect; do not execute yet

Read **both actual staged modules and the entire case yourself**. Static
inspection cannot establish that source is safe or that its behavior is correct.
These commands read and parse the selected files; they do not import the app,
start Docker, call AWS or create emulator resources.

**Bash**

```bash
cat "$PILOT/before/receipt_handler.py" "$PILOT/after/receipt_handler.py" "$PILOT/receipt-case.json" &&
node "$CLI" app-case-inspect "$PILOT/before/receipt_handler.py" "$PILOT/receipt-case.json" --json &&
node "$CLI" app-case-inspect "$PILOT/after/receipt_handler.py" "$PILOT/receipt-case.json" --json &&
node "$CLI" app-guide "$PILOT/before/receipt_handler.py" "$PILOT/receipt-case.json" --json &&
node "$CLI" app-guide "$PILOT/after/receipt_handler.py" "$PILOT/receipt-case.json" --json
```

**Windows PowerShell**

```powershell
Get-Content -LiteralPath "$Pilot/before/receipt_handler.py", "$Pilot/after/receipt_handler.py", "$Pilot/receipt-case.json" -Encoding UTF8
& node $Cli app-case-inspect "$Pilot/before/receipt_handler.py" "$Pilot/receipt-case.json" --json
if ($LASTEXITCODE -ne 0) { throw 'Before-source inspection failed.' }
& node $Cli app-case-inspect "$Pilot/after/receipt_handler.py" "$Pilot/receipt-case.json" --json
if ($LASTEXITCODE -ne 0) { throw 'After-source inspection failed.' }
& node $Cli app-guide "$Pilot/before/receipt_handler.py" "$Pilot/receipt-case.json" --json
if ($LASTEXITCODE -ne 0) { throw 'Before-source guide review failed.' }
& node $Cli app-guide "$Pilot/after/receipt_handler.py" "$Pilot/receipt-case.json" --json
if ($LASTEXITCODE -ne 0) { throw 'After-source guide review failed.' }
```

Personally confirm this contract before continuing:

- Both modules contain one direct `clients["s3"].put_object` call. The before
  module uses `encode("ascii", "ignore")`; the after module uses `encode("utf-8")`.
- The synthetic receipt in the case is **48 UTF-8 bytes**. The buggy encoding
  writes **43 bytes**. The same independent `HeadObject` assertion expects
  `ContentLength == 48` for both revisions, named `head-receipt.ContentLength`.
- The case invokes `handle` once, expects exactly one `s3.PutObject` attempt,
  and uses a fresh `$fixture` bucket and object key. Its cleanup deletes that
  object, then that bucket. No existing resources or customer data are used.
- Both `app-guide` reports have `readyForApproval: true`,
  `formalCaseSchemaValidated: true`, empty `reviewGaps`, and
  `status: "explicit_approval_required"`. The source hashes must differ.

An approval token in a static report is not execution evidence. This guide
neither extracts tokens nor uses `app-guide --run`. The comparison in Step 4
has **no `--approve` option**: entering that command is the explicit decision
to execute both reviewed sources. If you edit any source or case, repeat this
review. Do not change the expected length to make the before version pass.
The invariant establishes the intended byte length, not full content equality.

## 3. Prepare the image separately

This is still setup time. Run the read-only preflight and review its Docker,
image-provenance and disk results:

**Bash**

```bash
node "$CLI" preflight --json
```

**Windows PowerShell**

```powershell
& node $Cli preflight --json
```

Continue only when Docker is ready and the image report says
`imageReusable: true` and `imageSourceStatus: "matched"`.
`emulatorReady: true` or an exit code of zero alone is insufficient. If a
matching signed image is absent, review the download and disk requirements,
then **deliberately choose** the optional build below. Resolve any storage or
Docker failure before proceeding. Do not build merely to inspect the app.

**Bash — optional build only when needed, then recheck**

```bash
node "$CLI" build &&
node "$CLI" preflight --json
```

**Windows PowerShell — optional build only when needed, then recheck**

```powershell
& node $Cli build
if ($LASTEXITCODE -ne 0) { throw 'Image build failed; stop before execution.' }
& node $Cli preflight --json
```

## 4. Explicitly compare the same invariant before and after

Only after personal source/case review and matching-image preflight, run the
chosen shell block below. It **executes both trusted Python modules**, each in
its own disposable local lab, against the **same case file**. The explicit
`--prebuilt-only` flag refuses a missing or source-mismatched image **without
building**. Without that flag, the comparison command may build an image.
This flag does not pin an immutable image ID or make untrusted source safe.

**Bash**

```bash
node "$CLI" app-case-compare "$PILOT/before/receipt_handler.py" "$PILOT/after/receipt_handler.py" "$PILOT/receipt-case.json" --json --prebuilt-only
COMPARE_EXIT=$?
printf 'Comparison exit: %s\n' "$COMPARE_EXIT"
```

**Windows PowerShell**

```powershell
& node $Cli app-case-compare "$Pilot/before/receipt_handler.py" "$Pilot/after/receipt_handler.py" "$Pilot/receipt-case.json" --json --prebuilt-only
$ComparisonExit = $LASTEXITCODE
"Comparison exit: $ComparisonExit"
```

The **overall comparison should exit zero** when the intended failure is
reproduced before the fix and the repaired source passes. Inspect the JSON;
a nonzero command exit by itself is not a reproduced bug.

| Evidence | Required interpretation |
| --- | --- |
| `passed`, `bugReproduced`, `fixVerified` all `true` | The bounded before/after comparison succeeded. |
| `before.invoked` and `after.invoked` are `true` | Both selected functions ran. |
| Both `sdkCalls` lists show `s3.PutObject` with `attempts: 1`, `successes: 1` | The intended write actually succeeded in each run. |
| Only `head-receipt.ContentLength` fails before; it passes after | The same independent byte-length invariant detects this defect and its repair. |
| Distinct `before.sourceSha256` / `after.sourceSha256`, one shared `caseSha256`, matching emulator version | The report binds the two revisions to the reviewed case and emulator. |
| Both `cleanupPassed` values are `true` | Declared owned cleanup completed on both sides. |

The same `--prebuilt-only` option is available for a single `app-case` run.
Unknown or repeated flags are rejected before any Docker command.

The comparator hashes the canonical JSON case. Its `caseSha256` need not equal
the raw-file digest used by `app-guide` approval; keep each report's digest
with that report.

A startup failure, uncalled handler, SDK failure, application exception,
missing assertion, changed case, timeout, failed cleanup or unverified report
means **no verified before/after proof**. Do not count it as the expected red
result. A valid passing comparison remains a single synthetic emulator case;
`productionAwsValidated` stays `false`.

## 5. Keep a reviewed report and finish cleanup

Retain the comparison's JSON output and exit code locally. The JSON omits raw
source, input payloads, private file paths, application logs and exception
messages. Review its remaining case labels, step IDs and operation names
before sharing. Terminal transcripts and the source/case files need their own
privacy review; do not assume they are sanitized. Record the exact source
preview commit, reported source/case hashes, emulator version, assistance and
any failed attempts alongside the result. No report is submitted automatically.

Check successful `remove-receipt` and `remove-bucket` cleanup entries on both
sides. Cleanup is attempted even after a failed assertion; failure is still
an unsuccessful rehearsal. The staged files remain for inspection. After
preserving any report you want to keep, delete only the fresh external
workspace you created when you are finished with it.

For this maintained rehearsal, record **setup time** (checkout, prerequisites, staging, review and image
preparation) separately from **app-proof time** (the explicit comparison
through its verified result and cleanup). Do not count image downloads as a
fast app proof or report a target duration as a measured result. An offline
inspection-only attempt is `NOT_RUN` for application execution. For an own-handler
participant session, use the separate [evaluation protocol](pilots/EXTERNAL_APP_PILOT_EVALUATION.md):
its proof clock also includes source selection, adapter and case authoring, review,
and retries after environment readiness. Do not compare those durations as the
same measure.

## Applying the workflow to your own handler

For a later independent participant exercise, select a trusted self-contained
handler you own and use [GUIDED_APP_PROOF.md](GUIDED_APP_PROOF.md) to author,
review and explicitly approve a meaningful case. A successful independent
SDK state assertion with the required writes and cleanup establishes that
one case. A deliberately inverted expected-red assertion is a sensitivity
control. A genuine bug-fix claim additionally needs two distinct revisions
and a failed-before/passed-after comparison of the same reviewed invariant.
Completing this maintained rehearsal alone does not establish any of those
independent-participant outcomes.
