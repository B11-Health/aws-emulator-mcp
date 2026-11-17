# Get started with AWS Emulator MCP

AWS Emulator MCP connects a compatible local AI assistant to a disposable AWS development lab. You can run the examples directly from your terminal, or let the agent operate the local MCP tools.

## 1. See the real output on GitHub (no install)

The [latest GitHub release](https://github.com/B11-Health/aws-emulator-mcp/releases/tag/v0.4.0-beta.14)
includes a viewable SVG, an editable draw.io diagram, actual CloudFormation
YAML, a synthetic SDK contract, a bundled example archive and checksums.
This is the GitHub repository itself: there is no separate product website.

[Open the diagram](../examples/architecture/reference/diagram.svg) ·
[Inspect CloudFormation](../examples/architecture/reference/template.yaml) ·
[Read the release notes](https://github.com/B11-Health/aws-emulator-mcp/releases/tag/v0.4.0-beta.14)

## Check prerequisites before building the image

On the current `master` source checkout (the tagged beta.14 package **does not**
include this new command), run the read-only first-run check:

```bash
git clone --depth 1 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs preflight
node bin/aws-emulator-mcp.mjs preflight --json
```

The command checks Node.js 20+, Docker CLI, whether the selected Docker context
uses a local Unix socket or Windows named pipe, daemon availability and image
cache state. It does **not** contact AWS, pull an image, start a container,
run user Python source or dump environment variables. If Docker is missing or
stopped, it exits **1** with the next safe no-Docker command, and JSON is still
written to stdout. Invalid flags exit **2**. If the local daemon is ready,
it exits **0**; the first emulator command may still require a sizable signed
image download. The check **cannot** verify Docker disk capacity, upstream
service fidelity or production IAM.

On Windows PowerShell, the same two `node bin/aws-emulator-mcp.mjs preflight`
commands work from the repository checkout. For genuine first-run feedback,
share only the sanitized JSON after reviewing it, and report which step was
confusing: [developer field report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml).

## 2. Install and generate the architecture (no Docker)

Install **Node.js 20 or later**, Git and npm. Initial package installation
requires internet access, but generating the blueprint does not require
Docker, an AWS account, or production credentials.

~~~bash
npm install -g "github:B11-Health/aws-emulator-mcp#v0.4.0-beta.14"
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

## 4. Connect an AI assistant

Generate configuration appropriate to your client:

~~~bash
aws-emulator-mcp config vscode
aws-emulator-mcp config copilot
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
