# Rescue a failed first run without running another probe

**Round-four development preview only.** The `rescue` command reads an **already saved**
`preflight --json` or `connect-check --json` file and prints at most **three**
platform-aware, copyable next actions. It does not run those actions, call
Docker or AWS, read credentials, install software, build images, edit a desktop
configuration, or connect to an MCP client. It is different from `onboard`,
which generates a new seven-artifact *architecture-only* result and may perform
read-only Docker preflight unless `--offline` is selected.

Use a checkout containing the round-four feature (not the default `master` or
the published beta.15 CLI). If you already saved your JSON, **skip this entire
capture step**. Otherwise select **ONE** command, never both just to use rescue.

To capture a failing **preflight** (read-only local Docker/Node checks; no build):

```sh
node bin/aws-emulator-mcp.mjs preflight --json > preflight-report.json
```

**OR**, only if you deliberately want to capture a failing **connect-check**
(which may start a temporary network-isolated local MCP container, but never
builds or pulls an image):

```sh
node bin/aws-emulator-mcp.mjs connect-check --json > connect-report.json
```

The selected diagnostic may exit 1 when a check fails; the redirected JSON
is still useful. **You need only one saved report file to interpret**.
Do not run `connect-check` merely to interpret a failed preflight report.

Now run **only the interpreter** with a saved file you choose:

```sh
node bin/aws-emulator-mcp.mjs rescue "./preflight-report.json"
node bin/aws-emulator-mcp.mjs rescue "./connect-report.json" --json
```

Use one of these commands, not both. All examples are portable one-line
commands for PowerShell, macOS Terminal, and Linux. Double quotes protect
paths containing spaces. If installed locally from an npm tarball, run the
installed CLI from the installation directory instead of `node bin/...`;
the generated actions use a suitable local-package command when detected.

The input must be a bounded, regular local `.json` file (no URLs, UNC shares,
symlinks, device paths, or traversal). Malformed/unknown fields and contradictory
success claims are rejected with exit **2**. Interpretation success exits **0**
even when the **original** diagnostic failed; it does **not** mean the
emulator works. No report-supplied `nextCommand`, `reason`, file path,
credential or free-form text is ever copied into the advice. Commands and
warnings come only from a fixed local allowlist.

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
