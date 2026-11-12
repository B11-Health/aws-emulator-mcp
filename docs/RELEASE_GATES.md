# Release gates — AWS Emulator MCP

**Ownership:** B11-Health publishes source/releases; Code Gym publishes LinkedIn. Independent of AWS.

## Product thesis
AWS's official agent skill already installs and connects AWS Emulator. Our edge must be **repeatable agent-driven scenarios, measured reliability, clear failure analysis, and scoped cleanup** — not simply another API wrapper.

## Automated engineering gates

| Dimension | Release threshold |
| --- | --- |
| Unit and negative-security tests | 100% passing on Python 3.10 + 3.12, at least 100 cases |
| MCP interop | Legacy 2025-11-25 and modern 2026-07-28 independent checker passes |
| Catalog | At least 27 stable, schema-validated tools with read-only/destructive annotations |
| Credential isolation | HTTPS loopback only; only emulator credentials; STS account 000000000000 |
| Scenario reliability | 5/5 self-tests and 5/5 order demos pass, 100% cleanup |
| Performance | Warm order-demo p95 <=12 seconds, warm Windows installation <=30 seconds |
| No leaked test state | Run-created bucket, table and queue absent from final inventory |
| HTTP security | Auth and Origin/Host validation; strict modern MCP header matching |
| Supply chain | Official AWS package signature validated; reproducible wheel + clean commit |
| Client UX | Official Python and TypeScript SDKs work in both eras; native Copilot config and opt-in merge verified in Windows fixture; real desktop UX remains pending |

## Mandatory independent release gates

- Fresh Windows/WSL2 installation on an uninvolved host and native Linux installation against the current signed AWS release.
- Continuous integration green on the **public** B11-Health repository, with an accessible tag and license.
- Outside reviewer checks security boundaries, documentation, secret hygiene and cold install.
- A logged-out developer can clone, install and complete the order demo using public instructions only.
- Code Gym LinkedIn video reflects **the exact shipped commit**, records real execution and clearly states emulator fidelity limits.
- Public link works without login, is not the unrelated private Code Gym website repository, and has source provenance.

**Decision:** The automated scorecard can pass local engineering gates, but cannot by itself approve a public launch. Untested independent gates remain explicit BLOCKED items.

## Go-to-market outcomes after release
Track time-to-first-successful-test, installation completion rate, reproducible issue rate, returning developers and useful contributions. GitHub stars matter, but not as a proxy for actual adoption.

References: https://docs.aws.amazon.com/emulator/ and https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
