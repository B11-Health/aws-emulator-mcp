# Rescue a failed first run without running another probe

**Round-four development preview only.** The `rescue` command reads an **already saved**
`preflight --json` or `connect-check --json` file and prints at most **three**
platform-aware, copyable next actions. It does not run those actions, call
Docker or AWS, read credentials, install software, build images, edit a desktop
configuration, or connect to an MCP client. It is different from `onboard`,
which generates a new seven-artifact *architecture-only* result and may perform
read-only Docker preflight unless `--offline` is selected.

## Safe R4 clone, verify, and rescue

The development branch `release/agent-team-preview-r4-20261118` **moves as fixes are integrated**. Do **not** fetch/detach an old, static review SHA; that could deliberately run a prior vulnerable interpreter. The current branch SHA must match your checkout SHA **and** the head you independently review on [combined draft PR #91](https://github.com/B11-Health/aws-emulator-mcp/pull/91) at the time of execution. Git SHA agreement confirms version consistency, **not** independent source trust or a verified release. If the PR no longer tracks this same branch, or the PR head differs, **STOP** and ask for updated reviewed instructions. Neither the published `v0.4.0-beta.15`, default `master`, nor R3 preview contains this R4 rescue command.

The two blocks for your platform are **separate copyable steps**. Step 1 clones into a **new directory only** and aborts if the destination already exists or cloning fails. Step 2 verifies the repository root, canonical origin, clean tracked source, a fresh `git ls-remote` branch SHA, and your **explicit human-reviewed PR SHA**. It rechecks the remote and local tree immediately before invoking Node; if anything changed, it stops. No automatic Node execution follows a failed clone. The interpreter itself makes no Docker/AWS calls.

### macOS / Linux (POSIX shell)

**Step 1 — clone only, fail-stop, no Node:**

```sh
(
  set -eu
  repo='aws-emulator-mcp-r4'
  test ! -e "$repo" || { echo 'STOP: checkout directory already exists' >&2; exit 1; }
  git clone --depth 1 --branch release/agent-team-preview-r4-20261118 https://github.com/B11-Health/aws-emulator-mcp.git "$repo" || exit 1
)
```

**Step 2 — independently review PR #91, then verify and interpret one saved report:**

```sh
(
  set -eu
  repo='aws-emulator-mcp-r4'
  origin='https://github.com/B11-Health/aws-emulator-mcp.git'
  ref='refs/heads/release/agent-team-preview-r4-20261118'
  root=$(cd "$repo" && pwd -P) || exit 1
  actual_root=$(git -C "$repo" rev-parse --show-toplevel) || exit 1
  test "$actual_root" = "$root" || { echo 'STOP: unexpected repository root' >&2; exit 1; }
  actual_origin=$(git -C "$repo" remote get-url origin) || exit 1
  test "$actual_origin" = "$origin" || { echo 'STOP: unexpected Git origin' >&2; exit 1; }
  head=$(git -C "$repo" rev-parse --verify HEAD) || exit 1
  tracked=$(git -C "$repo" status --porcelain --untracked-files=no) || exit 1
  test -z "$tracked" || { echo 'STOP: tracked source changed' >&2; exit 1; }
  grep -Fq 'function imageRowMatchesState(r)' "$repo/scripts/report_rescue.mjs" || { echo 'STOP: old R4 interpreter lacks image-state fix' >&2; exit 1; }
  remote_line=$(git ls-remote --exit-code "$origin" "$ref") || exit 1
  remote_sha=$(printf '%s\n' "$remote_line" | cut -f1)
  remote_ref=$(printf '%s\n' "$remote_line" | cut -f2)
  test "$remote_ref" = "$ref" && test "$remote_sha" = "$head" || { echo 'STOP: checkout differs from current R4 remote HEAD' >&2; exit 1; }
  echo "R4 HEAD: $head"
  echo 'Independently inspect https://github.com/B11-Health/aws-emulator-mcp/pull/91 and confirm its CURRENT head SHA and source before continuing.'
  test -t 0 || { echo 'STOP: interactive review required' >&2; exit 1; }
  printf 'Type the full PR #91 SHA you personally reviewed: '
  IFS= read -r reviewed || exit 1
  test "$reviewed" = "$head" || { echo 'STOP: PR head not independently confirmed' >&2; exit 1; }
  # Fail if branch or checkout changed while you reviewed.
  again=$(git ls-remote --exit-code "$origin" "$ref") || exit 1
  test "$again" = "$remote_line" || { echo 'STOP: R4 branch moved during review' >&2; exit 1; }
  test "$(git -C "$repo" rev-parse --verify HEAD)" = "$head" || exit 1
  test -z "$(git -C "$repo" status --porcelain --untracked-files=no)" || exit 1
  cd "$repo" || exit 1
  node bin/aws-emulator-mcp.mjs rescue './preflight-report.json'
)
```

### Windows PowerShell (including PowerShell 5.1)

**Step 1 — clone only, fail-stop, no Node:**

```powershell
& {
  $repo = 'aws-emulator-mcp-r4'
  if (Test-Path -LiteralPath $repo) { throw 'STOP: checkout directory already exists' }
  git clone --depth 1 --branch release/agent-team-preview-r4-20261118 https://github.com/B11-Health/aws-emulator-mcp.git $repo
  if ($LASTEXITCODE -ne 0) { throw 'STOP: clone failed; never use an old checkout' }
}
```

**Step 2 — independently review PR #91, then verify and interpret one saved report:**

```powershell
& {
  $repo = 'aws-emulator-mcp-r4'
  $origin = 'https://github.com/B11-Health/aws-emulator-mcp.git'
  $ref = 'refs/heads/release/agent-team-preview-r4-20261118'
  $expectedRoot = (Resolve-Path -LiteralPath $repo -ErrorAction Stop).ProviderPath
  $actualRoot = git -C $repo rev-parse --show-toplevel
  if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($actualRoot).TrimEnd([char[]]@('\','/')) -ne [IO.Path]::GetFullPath($expectedRoot).TrimEnd([char[]]@('\','/'))) { throw 'STOP: unexpected repository root' }
  $actualOrigin = git -C $repo remote get-url origin
  if ($LASTEXITCODE -ne 0 -or $actualOrigin -cne $origin) { throw 'STOP: unexpected Git origin' }
  $head = git -C $repo rev-parse --verify HEAD
  if ($LASTEXITCODE -ne 0) { throw 'STOP: cannot read checkout commit' }
  $tracked = @(git -C $repo status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0 -or $tracked.Count -ne 0) { throw 'STOP: tracked source changed' }
  if (-not (Select-String -LiteralPath (Join-Path $repo 'scripts/report_rescue.mjs') -SimpleMatch 'function imageRowMatchesState(r)' -Quiet)) { throw 'STOP: old R4 interpreter lacks image-state fix' }
  $remoteLine = @(git ls-remote --exit-code $origin $ref)
  if ($LASTEXITCODE -ne 0 -or $remoteLine.Count -ne 1) { throw 'STOP: cannot verify current R4 branch' }
  $fields = $remoteLine[0] -split '\s+'
  if ($fields.Count -ne 2 -or $fields[0] -cne $head -or $fields[1] -cne $ref) { throw 'STOP: checkout differs from current R4 remote HEAD' }
  Write-Host "R4 HEAD: $head"
  Write-Host 'Independently inspect https://github.com/B11-Health/aws-emulator-mcp/pull/91 and confirm its CURRENT head SHA and source before continuing.'
  $reviewed = Read-Host 'Type the full PR #91 SHA you personally reviewed'
  if ($reviewed -cne $head) { throw 'STOP: PR head not independently confirmed' }
  # Fail if the branch or checkout changed during review.
  $again = @(git ls-remote --exit-code $origin $ref)
  if ($LASTEXITCODE -ne 0 -or $again.Count -ne 1 -or $again[0] -cne $remoteLine[0]) { throw 'STOP: R4 branch moved during review' }
  $now = git -C $repo rev-parse --verify HEAD
  if ($LASTEXITCODE -ne 0 -or $now -cne $head) { throw 'STOP: checkout moved during review' }
  $tracked = @(git -C $repo status --porcelain --untracked-files=no)
  if ($LASTEXITCODE -ne 0 -or $tracked.Count -ne 0) { throw 'STOP: tracked source changed' }
  Push-Location -LiteralPath $repo -ErrorAction Stop
  try { node bin/aws-emulator-mcp.mjs rescue '.\preflight-report.json' }
  finally { Pop-Location }
}
```

Copy **only the blocks for your platform**, in order. Do not paste a `cd` / `node` command independently after a failed clone. The report file is assumed to be an **untracked** `preflight-report.json` in the checkout; replace the quoted path with the **absolute local path** of an existing report (spaces supported) when necessary. The tracked-file check deliberately permits an untracked saved report. The source check also refuses the known older R4 interpreter that lacks `imageRowMatchesState`; **presence of that function is not a full security audit**, so you must still review PR #91 and confirm its current head. The tool **does not** query GitHub PR metadata to attest it. A remote branch or PR moving after review requires a fresh verified checkout. Never silently switch to an old commit as a workaround.

### Optional: capture a report separately

If you already have a saved report, **do not** rerun `preflight` or `connect-check`. Otherwise, run one diagnostic **only from a separately reviewed and verified checkout**. `preflight --json` checks Node/local Docker read-only; `connect-check --json` can start one isolated local MCP container using an existing matched image but does not build or pull. These probes are not part of offline `rescue`. Preserve the guarded checkout and consent checks when choosing to capture a new report, and save its JSON to a quoted local file.

Rescue itself reads one previously saved, bounded local JSON report. It returns 1–3 manual actions and exits **0** on successful interpretation even when the original diagnostic failed; exit **2** means the report was unsafe or invalid. It never performs Docker probes, image builds, AWS requests, configuration changes or execution of report-supplied commands. A suggested signed-image build is always a separate user opt-in.

## What the advice means

- **Missing Node.js**: install Node.js **20+ manually** and check its version.
  No installer runs automatically.
- **Docker blocked or remote**: inspect/select a **trusted local** Docker
  context and Linux-container mode yourself. Do not redirect to a remote
  TCP/SSH daemon or bypass the `connect-check` local-only guard.
- **Missing/stale/unverified image**: inspect actual Docker image storage
  (`docker system df` is shown only for you to run manually with a trusted
  local daemon). `build` is **explicit opt-in**: it downloads and verifies the
  official signed AWS Emulator package and builds a sizable local image.
  It requires network and free Docker Engine/Desktop VM storage; no pruning
  or automatic cleanup is performed.
- **Critical disk warning**: below **3 GiB** host-visible Docker data-root
  free space, no `build` command is suggested; fix capacity and recheck first.
  Below **10 GiB** is a conservative advisory. Neither working-directory nor
  host-visible data-root readings certify Docker Desktop VM capacity or
  actual available image-build space.
- **Failed MCP reply**: inspect prerequisites and retry `connect-check` only
  after correcting the local issue. A healthy read-only reply requires the
  exact lowercase `ok` health body. Do not mistake an HTTP 200 or malformed
  response for a successful local emulator check.
- **Passing `connect-check`**: this verifies a *terminal* MCP stdio initialize,
  tool listing, and read-only status result only. It does **not** prove that
  Claude Desktop or VS Code Copilot loaded your configuration. Review/install
  the printed MCP config yourself, then call `emulator_doctor` **from your real
  client** and inspect its actual reply. Neither check proves application
  correctness, production IAM behavior, or AWS cloud compatibility.

The interpreter never verifies an AWS API. A successful `onboard --offline`
result verifies seven locally generated architecture files, **not** AWS APIs.
For the actual first MCP connection and its safeguards, see [FIRST_RUN.md](FIRST_RUN.md).
