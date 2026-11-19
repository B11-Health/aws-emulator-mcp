# First result in one command

New to AWS Emulator MCP? **Start without an AWS account or Docker image download.**
This guide applies to a **development checkout containing the `onboard`
command**; it is **not included in the published v0.4.0-beta.15 release**.
For the released version, use [the existing beta.15 onboarding](ONBOARDING.md).

## 1. Verify that the local tools work

Requirements: Git, **Node.js 20+**, and a terminal (Windows PowerShell,
macOS Terminal, or Linux shell). Until this work merges, clone the **actual
unmerged integration preview branch**, rather than the default `master`
branch (which does not yet include this command):

```sh
git clone --depth 1 --branch release/agent-team-preview-20261118 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs onboard
```

[Review the unmerged integration preview PR #74](https://github.com/B11-Health/aws-emulator-mcp/pull/74).
The command is also under review in
[PR #71](https://github.com/B11-Health/aws-emulator-mcp/pull/71). The
preview branch is not a published release; review its source before using it.

After a future version containing this command is installed globally, run
`aws-emulator-mcp onboard` instead; its follow-up commands will use the
installed executable rather than assuming you are in a source checkout.

This runs a real, temporary local architecture-generation test and verifies
all **seven** generated artifacts and their checksums. The three resource types
are **S3, DynamoDB, and SQS**. The resulting 14-step synthetic contract is
**generated but NOT executed**. Temporary files are removed automatically.
**No application source, AWS APIs, production credentials or cloud resources
are accessed.** This first result is not an emulator test or a deployment.

The command then performs **read-only local Docker preflight**: version,
selected local Linux-container engine, image cache fingerprint and advisory
disk checks where supported. It prints a short, context-aware menu of
next commands, but does **not** execute them. Docker need not be installed.

Need to skip even the Docker probes? Run:

```sh
node bin/aws-emulator-mcp.mjs onboard --offline
```

For a redacted first-run troubleshooting report, use:

```sh
node bin/aws-emulator-mcp.mjs onboard --json
```

The JSON has a deliberately narrow `firstWin` status (architecture only),
`readiness` (not tested, blocked or prerequisites available), and
`nextSteps` (suggestions, never automatically run). **A successful first win
exits 0 even without Docker**; failure to produce the offline proof exits 1.
Invalid command options exit 2. Review any report before sharing it; please do
not include source, customer data, credentials, or private paths in feedback.

## 2. Choose the next thing you actually want

| Your goal | Command from the checked-out repository | What happens |
| --- | --- | --- |
| See output files | `node bin/aws-emulator-mcp.mjs architecture demo` | Saves diagrams, CloudFormation drafts and the unexecuted test plan under `reports/architecture-studio` |
| Inspect Python application code safely | `node bin/aws-emulator-mcp.mjs app-case-inspect examples/app-case/fixed.py --json` | Python 3.10+; scans one trusted file and proposes a reviewed starter case; no source execution or API call |
| Run real **local** emulator calls | `node bin/aws-emulator-mcp.mjs build`, then `node bin/aws-emulator-mcp.mjs doctor` | **Only when you intentionally opt in**; requires working local Docker Linux containers, a sizable signed package download and ample Docker storage |
| See a bug and verified fix | `node bin/aws-emulator-mcp.mjs app-debug compare` | Once Docker is working: runs the bundled order-intake example in an isolated emulator, checks independent state and cleanup |
| Configure AI coding assistant | `node bin/aws-emulator-mcp.mjs config copilot` | Prints a native VS Code Copilot MCP configuration; you review and install it yourself |
| Test a Python function you own | See [APP_CASE.md](APP_CASE.md) | Trusted-local handler against a **fresh, isolated emulator** with independent state assertions and cleanup |

If using the **installed CLI** from outside a checkout, the onboarding
report correctly uses `aws-emulator-mcp` commands and asks you to supply
just `YOUR_APP.py` for read-only source inspection instead of
pretending you have the repository's relative sample paths.

If the generated `onboard` report says `imageReusable: true`, you may
start with `doctor` rather than rebuilding. If it says a rebuild is needed,
**inspect actual Docker storage first**. Host free-space advisories cannot
prove Docker Desktop's VM capacity. The `build` command downloads and builds
a signed AWS Emulator package from AWS's installation channel; it does not
create an AWS account.

### Connect Claude Desktop without an unsigned extension

`config claude` was introduced in [round-two preview PR #80](https://github.com/B11-Health/aws-emulator-mcp/pull/80), but the first MCP response check was added in the **unmerged [round-three preview PR #85](https://github.com/B11-Health/aws-emulator-mcp/pull/85)**. The earlier PR #74 checkout above cannot run either feature. Use a separate **round-three** checkout for both commands, so the generated desktop configuration points to the same launcher you test:

```sh
git clone --depth 1 --branch release/agent-team-preview-r3-20261118 https://github.com/B11-Health/aws-emulator-mcp.git aws-emulator-mcp-r3
cd aws-emulator-mcp-r3
node bin/aws-emulator-mcp.mjs config claude
```

Or use `aws-emulator-mcp config claude` from a locally installed preview package containing these features; the current published beta.15 package does not. This generates a **Claude Desktop-specific** stdio entry. No settings file is changed, Docker image built or client connected.

Unlike `config copilot`, this output uses Claude Desktop's `mcpServers`
`command`/`args` shape **without** Copilot's `type: "stdio"` field. The values
contain the exact local Node executable and package path, JSON-escaped on
Windows as needed. Review and **merge the single `aws-emulator-local` entry**
into your existing `mcpServers` object; do not overwrite or discard other
servers. Claude Desktop's configuration file is
`%APPDATA%\Claude\claude_desktop_config.json` on Windows and
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.
See the [MCP client's configuration guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
for the current setup interface. **Before restarting Claude Desktop**, follow the explicit connection check below and review the Docker image build requirements; the normal MCP launcher can build an image when needed.

**Before enabling the connection**, run `preflight` and check Docker Desktop/
Engine in Linux-container mode. The `mcp` launcher can **build the large,
upstream-signed emulator image** when an image is missing or stale; this is
not a no-Docker offline check. If you do not want that build during client
startup, review disk capacity and explicitly run `build` and `doctor` from
the same CLI first. The generated JSON **does not edit Claude settings,
install Docker, run containers, download images or call AWS**. It is not a
signed extension. A successful `config claude` proves only config generation;
it does **not** prove that Claude Desktop loaded the server. After a real
connection, ask Claude to call `emulator_doctor`; inspect actual tool output
and local STS-account verification rather than assuming readiness. No
independent Claude Desktop connection is claimed here.

### Before your first MCP reply: explicitly check the local connection (round 3 draft)

After reviewing the generated Claude Desktop or Copilot entry, run the
following from that **same round-three preview checkout**, before restarting
the GUI:

```sh
node bin/aws-emulator-mcp.mjs connect-check --json
```

If you instead installed the round-three preview package, run
`aws-emulator-mcp connect-check --json`. Do **not** run `connect-check` from
the earlier round-two checkout: that checkout has `config claude` but does not
have the new command. The example above uses one-line commands compatible
with Windows PowerShell, macOS Terminal and Linux; quote any custom checkout
path containing spaces.

This is **not the offline architecture test**. It first verifies the selected
**local** Linux Docker Engine and the source fingerprint of the already-built
Docker image. If the image is missing, stale or unverified, it exits **1**
with `stage: "cached-image"` and suggests the **separate, explicit** `build`
command. **No Docker image is built, pulled, pruned or downloaded by
`connect-check`.** Before choosing `build`, inspect available Docker storage
and the expected signed upstream download; that operation requires internet
access and is **not** performed for you.

Only when a **matching cached image** exists, the check independently
rechecks the selected **local Unix socket or Windows named pipe** with an
explicit `docker --host`, verifies that daemon runs Linux containers, and
inspects the tag for both the matching source label and a content-addressed
`sha256:` image ID. It then starts one temporary local container using that
**pinned daemon endpoint and immutable image ID**, not the mutable default
Docker context and image tag. The run uses `--rm --network none --pull never`.
It sends bounded JSON-RPC `initialize`, `tools/list` and `tools/call` for
**read-only `emulator_status`**, requiring `running: true`, `installed: true`,
the exact `https://127.0.0.1:9297` endpoint **and** the exact lowercase
health response `body: "ok"`. Merely receiving HTTP 200, `body: "OK"`, or
`body: "NOT_OK"` is **not** enough. The SDK passes the health body through
without changing its case; the local signed emulator returns `ok`.

The source label is a local cache-coherency fingerprint, **not** a publisher
signature or AWS-production-fidelity check. If any daemon binding, image ID,
source label, health body, protocol reply or timeout check fails, the command
exits **1** with a sanitized stage; invalid flags exit **2**. No build,
image pull, application code, desktop settings update or production AWS call
is performed. Docker child processes do not receive ambient AWS credential
environment variables. A local Docker socket may itself be forwarded to a
remote daemon by user configuration; the user must select a trusted local
Engine. This command cannot certify physical daemon location.

**Interpretation:** `status: "passed"` means a local MCP stdio handshake and
read-only tool reply worked **from this terminal**. It does **not** establish
that Claude Desktop or Copilot loaded the JSON, that a later Docker session
will succeed, or that any AWS API, production IAM policy or application was
tested. Once the check passes, restart/connect your actual desktop client and
request `emulator_doctor`. Inspect and report **that client's actual tool
reply**. The only verified GUI result comes from the GUI, not this check.

### Failed preflight or connect-check? Read the saved report without probing again

`rescue` exists in the **R4 integrated development preview** only; it is **not** in the R3 checkout above, default `master`, or released `v0.4.0-beta.15`. R4 is **mutable**, and a previously recorded commit SHA is **not** a safe default after release-blocker fixes. No document can embed its own future release commit SHA.

**Step 1 - standalone clone command; do not run project code here:**

```sh
git clone --depth 1 --branch release/agent-team-preview-r4-20261118 https://github.com/B11-Health/aws-emulator-mcp.git aws-emulator-mcp-r4
```

**Step 2 - standalone read-only revision checks, without running Node:**

```sh
git -C aws-emulator-mcp-r4 rev-parse HEAD
git ls-remote https://github.com/B11-Health/aws-emulator-mcp.git refs/heads/release/agent-team-preview-r4-20261118
```

If clone fails or HEAD differs from the **current** branch SHA, **STOP**. Independently review [PR #91](https://github.com/B11-Health/aws-emulator-mcp/pull/91) and confirm its current integration HEAD matches the branch and checkout before executing any source. If PR #91 points elsewhere, stop and request updated reviewed instructions. The [fully gated shell-specific flow](REPORT_RESCUE.md#safe-r4-clone-verify-and-rescue) also verifies the Git origin, repository root, and clean tracked files, then requires you to type the exact reviewed SHA. It refuses to run Node from a stale checkout even if the branch advances during review.

With that flow, the interpreter consumes **already saved** preflight/connect-check JSON and provides up to three manual actions. It makes no Docker or AWS calls, installs nothing, and never changes settings. The conservative 3 GiB / 10 GiB host disk thresholds are not verified Docker VM capacity; a signed-image build remains a separate opt-in. A terminal MCP handshake never proves a desktop GUI or real AWS API test.

## 3. How do I know I tested my application?

The offline first win establishes **only** that the bundled local
architecture generator worked. The follow-up `doctor` verifies a separately
launched local emulator's health and isolated account, not your program.
To validate a trusted Python application's behavior, run a case with
developer-authored expected API calls and **independent readbacks**, and
compare a broken and corrected version. The local app runner has a strict
trust boundary: never execute unreviewed pull-request source or customer
code. Local Docker isolation is defense in depth, not a hostile-code
sandbox. No passing local emulator test establishes production AWS parity,
IAM enforcement, or release readiness.

The official [AWS Emulator agent skill](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-agent.html)
can install and configure AWS's local emulator. Our project is **independent**;
the [AWS-native companion work](https://github.com/B11-Health/aws-emulator-mcp/pull/69)
is reviewed separately and does not establish an AWS partnership or a shared
execution backend.

## 4. Help improve this first run

A useful first-run report contains the operating system, Node.js version,
whether Docker was installed, the exact command, and the sanitized `--json`
result. The JSON proves only that particular local run; we have **not
independently measured newcomer success rates**.

[Submit an independent first-run report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=independent_first_run.yml)
or [review current onboarding issues](https://github.com/B11-Health/aws-emulator-mcp/issues/47).
