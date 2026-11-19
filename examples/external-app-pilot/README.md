# External-workspace receipt app pilot (synthetic, maintained fixture)

This is a **maintained sample**, not evidence from an independent customer or
an external deployment. The goal is to show that an app *outside* the MCP
source checkout can use the **existing** `app-case-inspect`, `app-guide`, and
`app-case-compare` CLI with local absolute paths. It does not add a runner.

The two tiny, self-contained Python modules export the same
`handle(clients, inputs)` entrypoint and make one direct
`clients["s3"].put_object(...)` call. The intentionally broken revision uses
`receipt.encode("ascii", "ignore")`, dropping the accent and emoji. The fixed
revision uses `receipt.encode("utf-8")`. **Neither module is imported or run
by static inspection or draft creation.** Do not run unfamiliar source.

The **one reviewed JSON case** supplies an entirely synthetic UTF-8 receipt:

```text
RECEIPT R-1042
Item: café ☕
Total: USD 12.50
```

Its UTF-8 representation is **48 bytes**; ASCII-ignore drops two non-ASCII
characters and writes **43 bytes**. The independent SDK `HeadObject` asserts
`ContentLength == 48` after exactly **one** `s3.PutObject` attempt. The runner
creates a unique owned bucket via `{"$fixture":"bucket"}` and a unique
object key via `{"$fixture":"id"}`. Declared cleanup deletes the object
and then the bucket, even when the assertion fails. The same case and
regression path `head-receipt.ContentLength` apply to both versions.

## 1. Stage the three files OUTSIDE the checkout

Run from the **root of the MCP source checkout**, not from an arbitrary
working directory. This example makes a fresh sibling directory with spaces
in its path. Do not overwrite someone else's workspace.

**Bash / Linux / macOS**

```sh
REPO="$(pwd -P)"
STAGE="$(mktemp -d '../external receipt pilot.XXXXXX')"
STAGE="$(cd "$STAGE" && pwd -P)"
mkdir -p "$STAGE/before" "$STAGE/after"
cp "$REPO/examples/external-app-pilot/before/receipt_handler.py" "$STAGE/before/receipt_handler.py"
cp "$REPO/examples/external-app-pilot/after/receipt_handler.py" "$STAGE/after/receipt_handler.py"
cp "$REPO/examples/external-app-pilot/receipt-case.json" "$STAGE/receipt-case.json"
```

**Windows PowerShell (alternative staging)**

```powershell
$Repo = (Resolve-Path ".").Path
$Stage = Join-Path (Split-Path $Repo -Parent) ("external receipt pilot " + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path (Join-Path $Stage "before") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Stage "after") | Out-Null
Copy-Item (Join-Path $Repo "examples/external-app-pilot/before/receipt_handler.py") (Join-Path $Stage "before/receipt_handler.py")
Copy-Item (Join-Path $Repo "examples/external-app-pilot/after/receipt_handler.py") (Join-Path $Stage "after/receipt_handler.py")
Copy-Item (Join-Path $Repo "examples/external-app-pilot/receipt-case.json") (Join-Path $Stage "receipt-case.json")
```

The layout is:

```text
<parent-of-checkout>/external receipt pilot.XXXXXX/
  before/receipt_handler.py
  after/receipt_handler.py
  receipt-case.json
```

The source files and case are **ordinary, regular local files**. The pilot
does not mount the staged directory in Docker; the existing CLI separately
reads selected file bytes, hashes them, and (only after explicit execution)
sends trusted source through stdin to the isolated runner.

## 2. Inspect and review without executing the handlers

Each command below uses **absolute paths** and does not start Docker, import
the handlers, call AWS, or create emulator resources.

```sh
node "$REPO/bin/aws-emulator-mcp.mjs" app-case-inspect "$STAGE/before/receipt_handler.py" "$STAGE/receipt-case.json" --json
node "$REPO/bin/aws-emulator-mcp.mjs" app-case-inspect "$STAGE/after/receipt_handler.py" "$STAGE/receipt-case.json" --json
node "$REPO/bin/aws-emulator-mcp.mjs" app-guide "$STAGE/before/receipt_handler.py" "$STAGE/receipt-case.json" --json
node "$REPO/bin/aws-emulator-mcp.mjs" app-guide "$STAGE/after/receipt_handler.py" "$STAGE/receipt-case.json" --json
```

The equivalent single-line PowerShell inspection, for example, is:

```powershell
node (Join-Path $Repo "bin/aws-emulator-mcp.mjs") app-case-inspect (Join-Path $Stage "before/receipt_handler.py") (Join-Path $Stage "receipt-case.json") --json
node (Join-Path $Repo "bin/aws-emulator-mcp.mjs") app-guide (Join-Path $Stage "after/receipt_handler.py") (Join-Path $Stage "receipt-case.json") --json
```

Expect one discovered `s3.PutObject`, input keys `bucket`, `key`, `receipt`,
zero static review gaps, and two **different** source SHA-256 hashes tied to
the **same** case SHA-256. A reviewed valid case may yield
`explicit_approval_required` and a source/case-bound token; this is still
**static approval eligibility**, not execution evidence. Never claim a passing
application test from either command.

Optional read-only draft creation uses **a new file**, not the reviewed case:

```sh
node "$REPO/bin/aws-emulator-mcp.mjs" app-guide "$STAGE/before/receipt_handler.py" --draft "$STAGE/review-required-draft.json" --json
```

This draft is deliberately **not runnable** (`reviewRequired: true`, empty
setup/check/cleanup). Do not replace the reviewed case with a draft.

## 3. Explicit comparison after local image preparation

After personally reviewing both staged modules and the JSON case, follow the
[complete first-run guide](../../docs/EXTERNAL_APP_PILOT.md) for read-only
preflight and an optional, separate explicit image build. Immediately before
execution, require `imageReusable: true` and `imageSourceStatus: "matched"`;
a zero preflight exit code alone is insufficient.

The direct comparator has **no approval-token option**. Entering it explicitly
executes the current selected source and case bytes. Repeat review if those
files change. This Bash invocation prevents an implicit build; the complete
guide includes the equivalent temporary setting for PowerShell:

```sh
AWS_EMULATOR_MCP_QA_REQUIRE_PREBUILT=1 node "$REPO/bin/aws-emulator-mcp.mjs" app-case-compare "$STAGE/before/receipt_handler.py" "$STAGE/after/receipt_handler.py" "$STAGE/receipt-case.json" --json
```

Without this setting the existing comparator can build an absent or mismatched
image. The setting prevents that build; it does not pin an immutable image ID.

The command **executes trusted Python** in separate isolated emulator labs.
A successful comparison must show the broken source failing only the named
independent `HeadObject.ContentLength` assertion, the fixed source passing
that same assertion, one successful `s3.PutObject` per revision, distinct source
hashes, the same canonical case hash and emulator version, and successful
scoped cleanup on both sides. Other failures (setup, SDK, identity, timeout,
cleanup) are not confirmation of this regression. The measured invariant is
byte length, not full receipt-content equality.

The static commands and offline tests described here do not establish an
executed emulator comparison. Any executed result must be recorded separately
with the tested source and case digests, named regression result, write counts,
and cleanup outcomes. This maintained fixture does not establish
independent-user adoption or AWS production parity.

## Recorded maintained rehearsal

A maintainer ran the staged files from a separate Linux workspace containing
spaces on **2026-11-19**, using the unchanged runtime from R4 commit
`2e257dcb460037b6943ef6fe6e19766c03f5b0c0` and the verified signed AWS Emulator
**1.0.523**. The matching image was built explicitly before execution; implicit
builds were disabled during comparison. The selected bytes match this fixture.

The [recorded comparison JSON](../../docs/evidence/external-app-pilot-aws-emulator-1.0.523.json)
reports:

| Evidence | Before | After |
| --- | --- | --- |
| Selected handler invoked | Yes | Yes |
| Successful `s3.PutObject` calls / attempts | 1 / 1 | 1 / 1 |
| `head-receipt.ContentLength == 48` | Failed as expected | Passed |
| Object and bucket cleanup | Passed | Passed |

The overall comparison exited zero with `bugReproduced: true` and
`fixVerified: true`. No containers from the comparison remained. The report
records source hashes and the canonical case hash; it omits raw receipt data,
private paths, source text and response bodies. The byte counts above describe
the supplied encoding defect; the report exposes assertion outcomes, not raw
API response values.

This is one maintained Linux rehearsal. It is not a measured independent-user
completion rate, a native Windows Docker run, full-content verification, or a
production AWS parity result. The
[independent-developer protocol](../../docs/pilots/EXTERNAL_APP_PILOT_EVALUATION.md)
and its unused `NOT_RUN` template remain separate.
