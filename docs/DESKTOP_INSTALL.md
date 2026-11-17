# Connect AWS Emulator MCP to a desktop assistant

**Choose a local client, then verify one actual tool call.** The [Demo Studio](https://b11-health.github.io/aws-emulator-mcp/) explains six examples without connecting to AWS. The MCP adapter runs locally over stdio with Docker Engine in Linux-container mode.

This independent project is **not an AWS product or compatibility certification**. No AWS account or production credentials are needed. Initial Docker image construction downloads a signed upstream AWS Emulator package and needs substantial disk space. Emulator test results do not imply real AWS IAM enforcement.

## Start without Docker

You need Git and Node.js 20+ for the safe offline check:

~~~bash
git clone --depth 1 --branch v0.4.0-beta.15 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs try --json
node bin/aws-emulator-mcp.mjs preflight --json
~~~

The first command verifies generated files, **not AWS API behavior**. Preflight exits nonzero when Docker is missing; that is an expected, actionable prerequisite report.

## VS Code: native Copilot harness (recommended)

~~~bash
node bin/aws-emulator-mcp.mjs config copilot
~~~

This prints a local native **mcpServers** JSON entry with your actual Node executable and checkout path. It does not edit settings. In VS Code choose the Copilot harness, run **Chat: Open Customizations → MCP Servers → Add Server → Command (stdio)**, or place the generated entry in the native Copilot config at ~/.copilot/mcp-config.json (or $COPILOT_HOME/mcp-config.json). See the [official VS Code configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

For shared projects, use the workspace-root .mcp.json destination when the current Copilot setup flow offers it. The older **config vscode** command is retained for legacy editor-managed **servers** configurations only. New Copilot integrations should use **config copilot**. VS Code currently plans to remove the legacy Local harness in February 2027.

A native mcpServers definition is not interchangeable with .vscode/mcp.json. For remote workspaces, install the launcher and Docker on the execution host, not merely on the local laptop.

## Claude Desktop: optional MCP Bundle developer preview

This repository includes a **buildable, unsigned MCPB preview** for Windows and macOS. It bundles the reviewed Node launcher and local Docker build inputs from the npm package allowlist; **it does not bundle the large emulator binary**.

Maintainers can build and validate the archive with Python 3.10+, npm, and the pinned official MCPB CLI:

~~~bash
python scripts/build_desktop_mcpb.py --output aws-emulator-mcp-beta15-unsigned.mcpb
~~~

To install a verified preview archive in Claude Desktop, use **Settings → Desktop app → Manage Extensions → Advanced settings → Install Extension**, select the .mcpb file and review the requested local execution before accepting. [Claude's official extension guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) explains the controls.

**This is not an extension-directory listing or a production desktop release.** It is unsigned, and MCPB packages do **not** provide their own sandbox. A local MCP server runs with host-user permissions and may spawn Docker. Our launcher rejects remote Docker contexts and does not forward AWS credentials, but you still need to review and trust the source before installing. This extension does **not** install or start Docker for you. Its first emulator-backed command can initiate the signed package download/build after Docker is running.

On a connected Windows machine, we validated the MCPB manifest using the official CLI, unpacked the archive, and ran the bundled **try --json** and **preflight --json** commands. We have **not** verified a tool call inside Claude Desktop on a clean independent installation. Please send that external test result if you can.

After hosted CI, the preview can be downloaded as the unsigned **Desktop MCPB** workflow artifact. Do not use similarly named binaries from unrelated websites. This newer source-branch build is not a modification to the immutable beta.15 release tag.

## Verify a real tool call

With local Docker running in Linux-container mode:

~~~bash
node bin/aws-emulator-mcp.mjs doctor
~~~

Then ask your connected assistant:

> Use AWS Emulator MCP to run the reviewed order-intake duplicate-event test before and after the fix. Show observed assertions, cleanup checks and limits. Do not infer AWS production parity.

A valid config file alone **does not** demonstrate a working connection. Confirm the right MCP harness, Docker service, built image and client logs. Neither config copilot nor the desktop extension exposes a public HTTPS endpoint or makes the MCP available automatically in ChatGPT web.

Use the [short field report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml) for client, operating system, first tool result and blockers. Do not share private endpoints, account IDs, secrets, source code or customer information.
