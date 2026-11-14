# Get started with AWS Emulator MCP

AWS Emulator MCP connects a compatible local AI assistant to a disposable AWS development lab. You can run the examples directly from your terminal, or let the agent operate the local MCP tools.

## 1. Prepare your computer

Install **Node.js 20 or later** and **Docker Engine or Docker Desktop**, then start Docker. You do not need an AWS account or local AWS credentials. The first command that starts an emulator builds an image using AWS's signed Linux package, so you need an internet connection for the initial build and sufficient disk space (the cached image is over 1 GB).

| Operating system | Setup |
|:--|:--|
| Windows 11 | Use Node.js and Docker Desktop with **Linux containers**. Run commands in PowerShell. |
| macOS | Use Node.js and Docker Desktop, with Docker running before the first command. |
| Linux | Use Node.js and a working local Docker Engine socket. |

Automated Linux acceptance tests pass. Independent first-use Docker acceptance tests on a clean Windows/macOS computer are still welcome: [report your setup experience](https://github.com/B11-Health/aws-emulator-mcp/issues).

## 2. Install the launcher

~~~bash
npm install -g "github:B11-Health/aws-emulator-mcp#master"
aws-emulator-mcp doctor
~~~

The package is distributed from the GitHub repository until its first npm registry release. The `doctor` command checks Docker and the local emulator.

For reproducibility, pin the GitHub commit SHA you tested rather than following a moving branch. The full [installation notes](DOCKER_NPM_BETA.md) cover technical details.

## 3. Try the order-intake demo

~~~bash
aws-emulator-mcp app-debug compare
~~~

The CLI runs the same logical order twice through the example Python app, first with a duplicate-message bug and then with the packaged reference fix.

- **Before:** 2 accepted submissions; 2 SQS fulfillment messages.
- **After:** 1 accepted submission; 1 SQS fulfillment message.
- **Cleanup:** 7 checks pass for each variant.

The comparison returns a nonzero exit status if it cannot reproduce the bug, verify the correction, or clean up the resources it created.

[View the source and patch](APP_DEBUGGING.md) · [Watch the walkthrough](DEMO_GALLERY.md)

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

The catalog includes eight experiments. The SDK discovery bridge reaches the service models installed in the local SDK, but operation availability varies. The [measured coverage guide](COVERAGE.md) explains the difference between modeled APIs and successfully executed operations.

## Interactive tour

To explore the workflow before installing Docker, clone this repository and run a loopback-only static file server:

~~~bash
python3 -m http.server 8765 --bind 127.0.0.1
~~~

Then open **http://127.0.0.1:8765/docs/onboarding/**. The tour shows recorded results, navigates between stages, and highlights the pointer during mouse interaction. It requires no external service or account.

Need help? [Open an issue](https://github.com/B11-Health/aws-emulator-mcp/issues) with your operating system, Node and Docker versions, the exact command, and a sanitized error.
