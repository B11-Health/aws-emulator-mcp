# Changelog

## 0.3.0 — November 12, 2026 (local release candidate)

### Installation and onboarding
- Windows double-click installer: install.cmd + PowerShell, with an Ubuntu WSL2 quickstart and stable per-user installation location.
- Linux quickstart command: bash install.sh, rootless signed AWS Emulator package installation for amd64/arm64 Debian systems.
- Skips large AWS package download when an existing emulator is usable; verifies local TLS, generated credentials, and isolated STS identity.
- Generates ready-to-copy client and VS Code MCP configs; does not edit existing client settings.
- Windows demo.cmd plus Linux demo script for a real synthetic end-to-end order workflow.

### Application workflows
- New emulator_doctor tool and CLI health diagnostics.
- New emulator_order_demo tool with DynamoDB order, SQS queue, S3 receipt, expected missing-object failure, repair, readback assertions and scoped cleanup.
- 27 total tools; optional authenticated HTTP remains off by default.

### Protocol and security
- Integrated the GPT-6 Astra independent MCP stdio launch checker and its synthetic fixture tests.
- Corrected the kit's modern ping expectation: ping was removed in MCP 2026-07-28.
- Stricter S3 path-component validation; no redirects to external URLs, no real AWS credential use.
- Improved tool metadata and release QA reporting.

### Validation
- 103 unit tests passing on Windows and WSL2.
- Independent launch checker passed legacy and modern protocols.
- Live official AWS Emulator v1.0.322 checks passed for STS, S3, DynamoDB and SQS.
- Warm Windows installer and separate demo both completed successfully.

### Install and runtime safety
- Windows installer preflights managed paths and source content for symlinks and junctions before replacing any files.
- Linux quickstart validates AWS_EMULATOR_PORT and passes it to both detached and systemd startup modes.
- Forces LF checkouts for Bash scripts on Windows so WSL launchers cannot break from CRLF conversion.
- Adds a weekly signed-emulator compatibility CI run (no automatic release).
- Dedicated Windows junction fixture ensures unrelated files remain untouched when a malicious redirect is encountered.

### Native client onboarding
- Generates native VS Code Copilot mcpServers format alongside the legacy editor-managed servers format.
- Adds an opt-in Windows Copilot connector with preview, strict JSON parsing, conflict refusal, backup and idempotence.
- Benchmark captures source commit, emulator version and binary SHA256 for evidence provenance.
- A Code Gym video preview uses a real recorded dashboard rather than fabricated test footage.

### Evidence-first release hardening
- Strict MCP 2026 Streamable HTTP request header validation; failed order demo returns MCP tool error.
- Official TypeScript v2.4.0 and Python v2.3.0 client interoperability checks, in both protocol eras, including authenticated HTTP for Python.
- Five-run, fail-closed GTM benchmark and dependency-free offline HTML evidence dashboard.
- Source credential heuristic scan, version consistency assertions, and pinned GitHub CI with official signed emulator installation.
- Local benchmark 10/10 scenarios, p95 7.265 seconds, zero leaked demo resources; private GitHub Actions clean Linux run passed on AWS Emulator v1.0.336.

### Pending
- Public GitHub release and independent cold Windows installation verification.
- macOS/Docker quickstart and direct, authenticated remote MCP deployment.

## 0.2.0 — November 12, 2026
- Local STS/S3/DynamoDB/SQS MCP adapter, 25 tools, protocol and HTTP security tests.

## 0.1.0 — November 11, 2026
- Initial local stdio bridge to the official AWS Emulator.
