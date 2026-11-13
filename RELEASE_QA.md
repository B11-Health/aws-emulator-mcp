# AWS Emulator MCP v0.3.0 — release QA

Review date: November 12, 2026. GitHub publisher: **B11-Health**. LinkedIn publisher: **Code Gym**.

## Public developer-preview source — 2026-11-13

- The source repository `https://github.com/B11-Health/aws-emulator-mcp` was changed to **PUBLIC** and verified from an unauthenticated, separate EC2 environment: Git clone succeeded at commit `ac5fa465590ea2a067f6f9f08bffb416e6540f14`; both the GitHub page and raw README returned HTTP 200.
- PR #5's hosted pipeline passed on Linux Python 3.10/3.12, Windows 2025, the official Python/TypeScript MCP SDKs, Bandit static checks, and the full signed AWS Emulator Linux quickstart and integration benchmark.
- Local Windows 3.12 suite: 134 test cases, zero failures, two skips; Bandit 1.9.2 medium/high findings: zero.
- The [Code Gym technical video preview](https://32-185-50-90.sslip.io/codegym-aws-mcp-review-nov26/) is accessible on an unlisted no-index review page with the current developer-preview facts. The video is not an actual LinkedIn publication.
- **This is a public source preview, not a production security certification or v0.3 stable release.** Independent cold Windows installation, actual end-user desktop client usability, and outside security review remain open.

## Additional source hardening — 2026-11-13

Security-sensitive XML responses are now prevalidated by the stdlib Expat parser and **all DTD / entity declarations are rejected** before ElementTree processes the bounded response. Adversarial regressions cover ASCII and UTF-16 DTD payloads, malformed data, and oversized replies.

The optional remote connector's QA script now **refuses any destination other than the exact `http://127.0.0.1:PORT/mcp` endpoint**, ignores ambient HTTP proxies, and denies redirects so its private test edge token cannot be forwarded to a remote host. This does not expand the plugin's three-tool read-only surface.

Bandit v1.9.2 static scan over `src/aws_emulator_mcp` and `remote_connector`: **zero medium/high findings** after the changes. Four low-severity advisory findings remain (process execution through fixed emulator paths and non-cryptographic reconnect jitter). Static scanning is defense in depth, not independent security certification.

## Independent clean Ubuntu install — 2026-11-13 04:47 UTC

The source at `0f0a16c0bf90b74dd88904b298e5e5d2ae5129af` was cloned on a separate EC2 machine using a **temporary read-only deploy key**. Its GitHub SSH host key was checked against the officially documented ED25519 fingerprint. The key was revoked and deleted after cloning.

Inside a fresh **Ubuntu 24.04.5 Docker container** (no previously installed AWS Emulator or project dependencies), installing Python, curl, GPG and dpkg and running `bash install.sh` completed successfully:
- Official AWS Emulator **v1.0.338**, signed Debian package `1.0.338-1`, detached signature checked against AWS publisher fingerprint `98BCF336A3BE53B734E967C52E5BF49BD940F624`.
- Downloaded package SHA256: `7088f266fb16db7f5484001581360242580514f0920126c25a28ee1cb2c641f8`.
- Local health and identity **6/6 passed**, isolated STS account `000000000000`.
- Service self-test **13/13** and scoped cleanup **4/4** passed; legacy/modern protocol smoke checker **PASS**.
- Generated the local Linux and Copilot client configurations.
- `bash scripts/order_demo_linux.sh`: **PASS**, 12 steps, 2 recovery assertions, 4 cleanup actions; **6.132 seconds**.

A separate fresh Ubuntu 24.04 container with Python and Git ran the full test suite: **127 tests, 0 failures, 2 skips**. The initial combined container's unit-test command was not valid because the test image omitted Git; this was an environment setup error, not an application failure, and the suite passed when Git was installed.

This is an independent *machine/environment* check performed by the project team, **not an outside security audit or a second Windows host test**. Source remains private and release approval remains pending.

## Latest verified engineering run — 2026-11-13 03:52 UTC

- Source: clean Windows Git checkout at `a3cf4cc86b9b493d961003c4643d729de5b5d248`; MCP package v0.3.0.
- Local AWS Emulator: official v1.0.322, `https://127.0.0.1:9297`, isolated emulated STS account `000000000000`.
- Unit/security test invocation: **127 tests ran, 0 failures, 2 skips** on Windows Python 3.12.3.
- Pre-publication tracked-source heuristic scan: **69 files inspected, zero matching credential signatures**. Additional scan of 148 historical Git blobs found no matches for the checked credential patterns. **Neither scan replaces an independent security review**.
- Five live self-tests and five live order demos: **10/10 passed**; 27 MCP tools; independent legacy/modern MCP protocol smoke checks passed.
- Order-demo **p95 6.251 seconds** across five repetitions (release threshold 12 seconds); zero leaked demo resources; all eight automated engineering gates passed.
- Private GitHub Actions run [43359976374](https://github.com/B11-Health/aws-emulator-mcp/actions/runs/43359976374) completed successfully for the same commit.
- The local benchmark explicitly reported `public_release_approved: false`. Remaining gates: independent Windows cold-install, actual desktop MCP-client UX, outside security review, logged-out public repository/CI check, and a genuine write-capable local MCP launch recording.

These measurements do **not** demonstrate production AWS fidelity, IAM security, or multi-user remote-write support. Older evidence below is retained as dated historical records.

**Engineering release candidate: verified on the author's Windows/Ubuntu WSL2 host. Public publishing still gated.**

## Verified local evidence

- Official AWS Emulator: v1.0.322, isolated account 000000000000, HTTPS on 127.0.0.1:9297. The emulator binary originated from an AWS package that previously passed signature verification.
- 27 MCP tools with no external Python runtime dependencies.
- **103 unit and security tests passed on Windows Python 3.12 and Ubuntu WSL2 Python 3.12.** Includes 29 fixture-based tests from the Astra launch kit.
- Independent launch checker: PASS with the actual server command for both legacy MCP 2025-11-25 and modern MCP 2026-07-28. A false negative in the kit's modern ping expectation was corrected to match the MCP specification.
- Live integration: 13 STS/S3/DynamoDB/SQS service checks and four scoped cleanup operations passed.
- New synthetic order demo: 12 successful workflow steps, two deterministic failure/recovery assertions, and four scoped cleanup operations passed against the official emulator.
- Real Windows PowerShell installer: EXIT 0, about 11.8 seconds on an **already provisioned** emulator; copied files into a stable per-user installation folder and generated both MCP and VS Code JSON configurations.
- Real Windows demo launcher: EXIT 0, about 7.3 seconds, with a synthetic order report saved in the installed reports folder.
- The HTTP transport remains disabled by default and binds to loopback only when explicitly started. The adapter never exposes an AWS endpoint override.

## Honest limitations

- The **first-time network download** branch of the revised installer has not been fully rerun on a clean Windows device. It verifies the AWS detached package signature before execution, but the cold end-to-end timing/experience is not yet independently measured.
- The one-click path is verified for Windows with Ubuntu WSL2 preinstalled. macOS, RPM Linux, and Docker-only setups require separate work.
- Generated MCP client config is tested locally; broad compatibility with third-party clients still needs more independent testers.
- ChatGPT web cannot reach the local stdio or loopback HTTP server directly. This release does **not** claim public ChatGPT-hosted MCP connectivity.
- AWS Emulator itself is not production AWS: service fidelity, IAM/security behavior, and state persistence vary. No cloud-level guarantees follow from local success.

## Publication gates

1. Independent clean first-time installation, ideally on a second Windows/WSL host and one native Linux machine.
2. Verify the public GitHub repository, license, CI status, release commit and artifact SHA256 while logged out.
3. Update Code Gym's LinkedIn video and announcement to the final **v0.3.0 / 27-tool** facts (previous explainer v0.2.0 is not a current release demonstration).
4. Public source release **before** announcing the download URL. No GitHub publication or LinkedIn post is performed by this QA task.

All examples and test data are synthetic; never run with production secrets. The output is an independent community integration, not an AWS product.

## New local GTM evidence

The automated benchmark ran on Ubuntu WSL with three isolated self-tests and three order workflows: 6/6 passed, order p95 7.45 seconds, four scoped cleanup actions in each run, and zero leaked order resources. The independent protocol checker and 103-unit-test suite passed. This is local evidence only; no public CI checks have yet run. The independent Amazon Linux host verified a newer AWS Emulator v1.0.336 RPM signature, but full cross-host application runtime QA remains gated.


## Latest private GitHub Actions evidence

- Repository: B11-Health/aws-emulator-mcp (PRIVATE, not yet released).
- CI run 43287887580: all four jobs passed on clean hosted runners: Python 3.10 unit/protocol/wheel, Python 3.12 unit/protocol/wheel, official Python/TypeScript SDK clients, and signed official AWS Emulator live E2E + 5-run reliability benchmark.
- Hosted Linux run verified AWS Emulator v1.0.336 GPG signature, installed it rootlessly, and confirmed emulated STS account 000000000000.
- Local benchmark on Windows/WSL: 5/5 service self-tests plus 5/5 order workflows, order workflow p95 7.265 seconds, zero leaked order resources and complete scoped cleanup.
- Latest local suite: 103/103 Windows and 103/103 Ubuntu WSL2.
- Python SDK 2.3.0 additionally passed authenticated Streamable HTTP in legacy and modern modes. Optional localhost listener remains off by default.
- The offline report viewer uses only sanitized benchmark fields and rejects malicious HTML data injection; no external assets.

This is stronger engineering validation, but it still **does not approve publication**. Separate clean Windows first-install QA, a desktop-host UX test, independent security review, and a real matched Code Gym launch video remain outstanding.


## New onboarding and provenance evidence

- Current VS Code Copilot uses native mcpServers configuration; the older editor-managed servers format is deprecated. The generator now emits both.
- Opt-in connect-copilot.cmd was exercised against a temporary Windows Copilot configuration: preview unchanged, unrelated servers preserved, backup present, and idempotent second apply. It is never run automatically by installation.
- The engineering benchmark captures the exact git commit, dirty-worktree state, official emulator version and emulator binary SHA256. Local passing tests never authorize public release.
- Code Gym preview: 118.3-second H.264/AAC video with actual dashboard browser capture and captions. It remains private pending a released-commit factual match.

## Installer boundary and port regression
- A Windows test created a junction redirecting the managed install into a separate test directory. Installer refused it before mutation and the sentinel file remained intact.
- Linux quickstart validates port range and consistently passes the chosen port to AWS Emulator. Added negative tests for invalid values.
- The new hosted Windows Actions job tests launcher syntax, source scan, and non-mutating installation preview on a clean Windows 2025 runner.
- The nested-directory junction regression was also reproduced on Windows: the installer refused the redirect and preserved the sentinel outside the install tree.

## Private ChatGPT and Windows relay integration (November 12, 2026)

- Registered personal plugin Code Gym AWS Emulator - Secure QA using a
  dedicated HTTPS MCP URL, no OpenAI API key.
- OpenAI mTLS client-certificate validation in nginx with current published
  OpenAI root/connector CA chain and additional backend SAN/clientAuth check.
- Bound gateway to 127.0.0.1 only, with random unguessable capability path,
  private edge verification token and ONLY three diagnostic tool names.
- TLS WSS agent from Windows/WSL connects outward to separate relay hostname,
  single agent authenticated with independent 384-bit credential in 0600 files.
- Tested from real ChatGPT conversation: emulator_doctor, emulator_identity
  and emulator_status returned true Windows values: 127.0.0.1:9297,
  official emulator 1.0.322, 6/6 checks and isolated account 000000000000.
- Gateway application security suite: 10/10 checks including legacy/modern
  MCP protocol compatibility, no edge token, bad client certificates, bad
  origin and denied write tools. mTLS also verified at TLS edge separately.
- Reproducible source, dependencies, deployment templates and stdlib contract
  tests live under remote_connector/. The remote connector is OPTIONAL and
  requires separate security review for multi-user/public deployment.

This does NOT certify AWS production IAM security or permit public rollout.
