# AWS Emulator MCP v0.3.0 — release QA

Review date: November 12, 2026. GitHub publisher: **B11-Health**. LinkedIn publisher: **Code Gym**.

**Engineering release candidate: verified on the author's Windows/Ubuntu WSL2 host. Public publishing still gated.**

## Verified local evidence

- Official AWS Emulator: v1.0.322, isolated account 000000000000, HTTPS on 127.0.0.1:9297. The emulator binary originated from an AWS package that previously passed signature verification.
- 27 MCP tools with no external Python runtime dependencies.
- **94 unit and security tests passed on Windows Python 3.12 and Ubuntu WSL2 Python 3.12.** Includes 29 fixture-based tests from the Astra launch kit.
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

The automated benchmark ran on Ubuntu WSL with three isolated self-tests and three order workflows: 6/6 passed, order p95 7.45 seconds, four scoped cleanup actions in each run, and zero leaked order resources. The independent protocol checker and 94-unit-test suite passed. This is local evidence only; no public CI checks have yet run. The independent Amazon Linux host verified a newer AWS Emulator v1.0.336 RPM signature, but full cross-host application runtime QA remains gated.
