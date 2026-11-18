# First result in one command

New to AWS Emulator MCP? **Start without an AWS account or Docker image download.**
This guide applies to a **development checkout containing the `onboard`
command**; it is **not included in the published v0.4.0-beta.15 release**.
For the released version, use [the existing beta.15 onboarding](ONBOARDING.md).

## 1. Verify that the local tools work

Requirements: Git, **Node.js 20+**, and a terminal (Windows PowerShell, macOS
Terminal, or Linux shell). Clone the repository and from that directory run:

```sh
git clone --depth 1 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs onboard
```

While the change is still a draft PR, preview its branch directly:

```sh
git clone --depth 1 --branch feat/onboarding-first-win-20261118 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs onboard
```

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
the [AWS-native companion proposal](https://github.com/B11-Health/aws-emulator-mcp/pull/69) is still a separate
draft PR, not a merged capability or AWS partnership.

## 4. Help improve this first run

A useful first-run report contains the operating system, Node.js version,
whether Docker was installed, the exact command, and the sanitized `--json`
result. The JSON proves only that particular local run; we have **not
independently measured newcomer success rates**.

[Submit an independent first-run report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=independent_first_run.yml)
or [review current onboarding issues](https://github.com/B11-Health/aws-emulator-mcp/issues/47).
