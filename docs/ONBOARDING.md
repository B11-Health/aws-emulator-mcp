# Get started with AWS Emulator MCP

AWS Emulator MCP connects a compatible local AI assistant to a disposable AWS development lab. You can run the examples directly from your terminal, or let the agent operate the local MCP tools.

## Prefer a single first-run command?

In source checkouts that include the **new `onboard` command** (not the
immutable beta.15 tag), run `node bin/aws-emulator-mcp.mjs onboard`.
It verifies offline architecture artifacts, checks Docker prerequisites
without starting any containers, and prints optional next steps.
Use `--offline` to avoid even Docker probing, or `--json` to report your
setup. [Start with the shorter guide](FIRST_RUN.md).

## Start by watching the example

[**Narrated beta.15 walkthrough (87 seconds)**](assets/demos/proof-first-beta15.mp4) · [Six interactive demo missions](https://b11-health.github.io/aws-emulator-mcp/) · [Accessible transcript](SHOWCASE_TRANSCRIPT.md) · [Common questions before trying](https://b11-health.github.io/aws-emulator-mcp/#faq)

The first mission only verifies local architecture generation. Docker-backed
labs are optional next steps; you need a local Docker Engine with Linux
containers and sufficient disk space to run real emulated API calls.

## 1. See the real output on GitHub (no install)

The [latest GitHub release](https://github.com/B11-Health/aws-emulator-mcp/releases/tag/v0.4.0-beta.15)
includes a viewable SVG, an editable draw.io diagram, actual CloudFormation
YAML, a synthetic SDK contract, a bundled example archive and checksums.
A public [GitHub Pages Demo Studio](https://b11-health.github.io/aws-emulator-mcp/) is available for exploring the reviewed missions; it is a static educational site and does **not** run emulated AWS APIs in your browser.

[Open the diagram](../examples/architecture/reference/diagram.svg) ·
[Inspect CloudFormation](../examples/architecture/reference/template.yaml) ·
[Read the release notes](https://github.com/B11-Health/aws-emulator-mcp/releases/tag/v0.4.0-beta.15)

## First step: a disposable, offline architecture test

In a beta.15 checkout, run:

```bash
git clone --depth 1 --branch v0.4.0-beta.15 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs try
node bin/aws-emulator-mcp.mjs try --json
```

This does not require Docker, an AWS account, npm global install, or
credentials. It creates a throwaway working directory, generates and checks
all seven Architecture Studio files (including hashes), and deletes that
directory. It reports the generated 14-step synthetic SDK contract as **not
executed**; no emulator, AWS endpoints or production resources are touched.
A passing trial does **not** establish AWS fidelity or IAM behavior. To keep
the outputs, use `node bin/aws-emulator-mcp.mjs architecture demo`.

Please share the sanitized JSON with a [first-run field report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml),
including what would make the next step useful. Do not paste private source,
credentials, endpoints or customer data.

## Check prerequisites before building the image

On a beta.15 source checkout, run the read-only first-run check:

```bash
git clone --depth 1 --branch v0.4.0-beta.15 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs preflight
node bin/aws-emulator-mcp.mjs preflight --json
# The no-Docker fallback works directly from the checkout:
node bin/aws-emulator-mcp.mjs architecture demo
```

The command checks Node.js 20+, Docker CLI, whether the selected Docker context
uses a local Unix socket or Windows named pipe, Docker Linux-container mode, daemon availability and image
cache state. It does **not** contact AWS, pull an image, start a container,
run user Python source or dump environment variables. If Docker is missing or
stopped, it exits **1** with the next safe no-Docker command, and JSON is still
written to stdout. Invalid flags exit **2**. If the local daemon is ready,
it exits **0**; the first emulator command may still require a sizable signed
image download. A cached Docker tag is **not** proof it matches the current
source checkout; on `master`, the CLI compares an embedded build-input digest
before launching and rebuilds on a mismatch.

**Additional diagnostics on the newer `master` branch (not in the immutable
beta.15 tag):** `preflight --json` includes a `hostWorkspaceDisk` advisory,
`imageSourceStatus`, and `imageReusable`. The host working-volume measurement
can warn when it has under **10 GiB** of free space, but this is a **conservative
planning advisory, not a minimum emulator requirement**. On Linux, when the
local Docker Engine's data-root directory is also **visible on the host**,
`hostVisibleDockerRootDisk` reports a second, more relevant host-volume
reading. It still cannot prove that the daemon shares the same filesystem
namespace or that an image build will fit. The daemon's private data-root
**path is never printed**. Docker Desktop may store images in a different
VM/disk, so a healthy host-space result **does not verify actual Docker storage
capacity**. With a cached tag, preflight now checks
the local Docker-copy source fingerprint and warns if an existing image would
be rebuilt. The fingerprint is only a local cache-coherency check, **not**
proof of an authentic package, emulator parity, IAM enforcement or upstream
service fidelity. Preflight performs no download, build, prune or cloud call.

On Windows PowerShell, the same two `node bin/aws-emulator-mcp.mjs preflight`
commands work from the repository checkout. For genuine first-run feedback,
share only the sanitized JSON after reviewing it, and report which step was
confusing: [developer field report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml).

## 2. Install and generate the architecture (no Docker)

Install **Node.js 20 or later**, Git and npm. Initial package installation
requires internet access, but generating the blueprint does not require
Docker, an AWS account, or production credentials.

~~~bash
npm install -g "github:B11-Health/aws-emulator-mcp#v0.4.0-beta.15"
aws-emulator-mcp architecture demo
~~~

Open `reports/architecture-studio/diagram.svg`, edit
`diagram.drawio` in diagrams.net, or review `template.yaml`.
These are resources and conceptual flows, not a deployed application.

The package is distributed from the GitHub repository until its first npm
registry release. Pin this tested tag or an exact commit for reproducibility;
see the [installation notes](DOCKER_NPM_BETA.md).

## 3. Start Docker to run local AWS API tests

Docker is only required for emulator-backed operations. Install and start
Docker Engine or Docker Desktop, then run the health check. You do not need
an AWS account or local AWS credentials. The first emulator command builds a
local image using AWS's signed Linux package, requires internet connectivity,
and needs sufficient free space (the cached image is over 1 GB).

| Operating system | Emulator requirements |
|:--|:--|
| Windows 11 | Docker Desktop with **Linux containers**; commands work in PowerShell. |
| macOS | Docker Desktop running. |
| Linux | A working local Docker Engine socket. |

~~~bash
aws-emulator-mcp doctor
aws-emulator-mcp app-debug compare
# Optional: manually test a handler YOU own and trust.
# The example path works from a checkout of this repository; otherwise
# supply the path to your own local Python source file.
aws-emulator-mcp app-verify examples/byo-order-handler/fixed.py --json
~~~

The opt-in [user handler pilot](BYO_HANDLER.md) is local-terminal-only.
It executes selected Python in a one-shot network-disabled Docker
container and is **not** a remotely callable MCP/PR code runner.
Use only personally trusted, synthetic source.

Automated Linux acceptance tests pass. Independent first-use Docker
acceptance on a clean Windows/macOS machine is welcome:
[report your setup experience](https://github.com/B11-Health/aws-emulator-mcp/issues).

The CLI runs the same logical order twice through the example Python app, first with a duplicate-message bug and then with the packaged reference fix.

- **Before:** 2 accepted submissions; 2 SQS fulfillment messages.
- **After:** 1 accepted submission; 1 SQS fulfillment message.
- **Cleanup:** 7 checks pass for each variant.

The comparison returns a nonzero exit status if it cannot reproduce the bug, verify the correction, or clean up the resources it created.

[View the source and patch](APP_DEBUGGING.md) · [Watch the walkthrough](DEMO_GALLERY.md)

You can also investigate retry behavior with
`aws-emulator-mcp failure-lab compare`. It reproduces a missing SQS event,
then verifies pending-state recovery and duplicate-safe consumer markers.
[Watch the guided Failure Lab clip](assets/demos/failure-lab.mp4) or
[inspect the saved result](evidence/failure-lab-aws-emulator-1.0.385.json).

## Desktop assistant setup

[**VS Code Copilot and Claude Desktop install guide**](DESKTOP_INSTALL.md) explains the current native Copilot configuration and an optional unsigned MCPB preview for Claude Desktop. Both require a local Docker Engine for emulator-backed MCP tools.

## 4. Connect an AI assistant

Generate configuration appropriate to your client:

~~~bash
aws-emulator-mcp config copilot
# Legacy editor-managed VS Code settings only:
aws-emulator-mcp config vscode
~~~

Copy the output to your supported editor's MCP settings. The launcher communicates over standard input/output; there is no public listener.

Ask:

> Inspect the order-intake sample. Explain the duplicate SQS event, run the before-and-after test, and show which application checks pass.

## 5. Discover other experiments

~~~bash
aws-emulator-mcp experiments
aws-emulator-mcp experiment sns-sqs-delivery
aws-emulator-mcp experiment ec2-vpc-lifecycle
aws-emulator-mcp coverage
~~~

For an agent-authored retry experiment, run
`aws-emulator-mcp contract fault-demo --json` or ask your coding assistant
to call `contract_guide` and propose a declarative failure contract for an
AWS SDK workflow in your repository. It tests emulated API operations, not
your application source or a real service outage.
[See the fault contract format](CONTRACT_TESTING.md).

The catalog includes eight experiments. The SDK discovery bridge reaches the service models installed in the local SDK, but operation availability varies. The [measured coverage guide](COVERAGE.md) explains the difference between modeled APIs and successfully executed operations.

## Interactive tour

To explore the workflow before installing Docker, clone this repository and run a loopback-only static file server:

~~~bash
python3 -m http.server 8765 --bind 127.0.0.1
~~~

Then open **http://127.0.0.1:8765/docs/onboarding/**. The five-stage tour shows recorded results, navigates between stages, and highlights the pointer during mouse interaction. It requires no external service or account.

Need help or want to critique the product? [Submit a field report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml)
with your operating system, client, exact command, and a sanitized result.
[See the expert review questions](COMMUNITY_REVIEW.md).
