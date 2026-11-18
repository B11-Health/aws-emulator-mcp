# Contributing to AWS Emulator MCP

Thank you for helping make local cloud experimentation more reliable.

## Join without repository write access

This is an **independent adapter**, not an AWS product. Outside testing,
documentation, accessibility reviews, API mismatch reports, and small,
well-tested fixes are welcome. You **do not need a collaborator invitation**
or an AWS account to participate: comment on an issue, fork the repository,
and open a pull request.

**Current newcomer tasks:**

- [Windows 11 first run (#7)](https://github.com/B11-Health/aws-emulator-mcp/issues/7)
- [Mac/Copilot first run (#8)](https://github.com/B11-Health/aws-emulator-mcp/issues/8) (assigned; coordinate in the thread)
- [Linux Engine first run (#50)](https://github.com/B11-Health/aws-emulator-mcp/issues/50)
- [Claude Desktop MCPB first run (#51)](https://github.com/B11-Health/aws-emulator-mcp/issues/51) (unsigned preview: review permissions first)
- [Demo Studio accessibility (#52)](https://github.com/B11-Health/aws-emulator-mcp/issues/52)

Share a structured [independent first-run report](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=independent_first_run.yml), whether the test passed or failed.

See all [open good-first-issue tasks](https://github.com/B11-Health/aws-emulator-mcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
To claim an unassigned task, comment with the **specific step you can test or
change**. A maintainer can assign it without granting repository write access.
Coordinate on already-assigned issues instead of duplicating effort.

## A safe, zero-Docker starting point

With Git and Node.js 20+, you can reproduce the immutable beta.15
architecture trial and local setup diagnostics without an AWS account:

~~~sh
git clone --depth 1 --branch v0.4.0-beta.15 https://github.com/B11-Health/aws-emulator-mcp.git
cd aws-emulator-mcp
node bin/aws-emulator-mcp.mjs try --json
node bin/aws-emulator-mcp.mjs preflight --json
~~~

The trial verifies **seven generated artifacts**, not AWS APIs. A nonzero
preflight status when Docker is missing is an expected diagnostic, not a
failed trial. Printed MCP config does **not** prove a working client session.
Docker-backed testing requires local Linux Docker Engine/Desktop and a sizable
signed upstream image build. The newer `master` branch has extra
read-only disk/cache checks not present in the immutable beta.15 tag.
See the [desktop guide](docs/DESKTOP_INSTALL.md) and
[FAQ](https://b11-health.github.io/aws-emulator-mcp/#faq).

## Open a reviewed pull request

1. **Fork** the public repository using GitHub. Create a descriptive branch
   from current `master` in your fork; no push access to our repository is needed.
2. Focus on **one issue**. For a documentation change, identify the misleading
   command or inaccessible screen. For code, add a regression test.
3. Run the checks relevant to the change from the repository root:

~~~sh
npm test
PYTHONPATH=src python3 -m unittest discover -s tests -q
~~~

On PowerShell, set `$env:PYTHONPATH = 'src'` before the Python command.
The Node unit suite does not require Docker. Runtime changes need a separate
real local Docker test where feasible; hosted CI runs the full signed-emulator
suite.
4. Open a PR against `B11-Health/aws-emulator-mcp:master` using the PR
   checklist. Include observed vs expected outcomes, versions, sanitized
   evidence, provenance and limitations. We require successful checks and
   review before merging.

Contributions remain attributable in the public GitHub issue/PR history.
Forks and reviewable PRs are the normal path; additional repository permissions
are considered separately when genuinely needed.

## Reproduce before proposing a feature

1. Follow the current [onboarding](docs/ONBOARDING.md) or [desktop guide](docs/DESKTOP_INSTALL.md), checking whether you are on a published tag or newer source.
2. Run the unit suite: python3 -m unittest discover -s tests -v
3. Run the independent checker against the actual server in scripts/mcp_launch_check.py.
4. Use a disposable emulator to run scripts/live_test.py.
5. Attach a concise reproduction with the emulator version, MCP protocol version, expected behavior, actual result, and sanitized evidence. Do not include credentials, customer data, or private host paths.

## Independent technical reviews

We welcome reviewers who wouldn't use the project. Please start with the
[community review checklist](docs/COMMUNITY_REVIEW.md) and the
[structured field-report form](https://github.com/B11-Health/aws-emulator-mcp/issues/new?template=field_report.yml).
Tell us which steps failed, which features duplicate native AWS Emulator
tooling, or which reliability experiment would affect your decision to adopt.
Do not imply AWS sponsorship or endorsement.

## Good first contributions

- Add one AWS Emulator operation with a strict JSON Schema, tests, and clearly described fidelity limitations.
- Contribute a reproducible emulator API mismatch with minimal synthetic data.
- Improve onboarding across Windows WSL2, Debian/Ubuntu, or an independently verified Docker/macOS route.
- Add a tiny complete workflow demonstrating failure, diagnosis, repair, and scoped cleanup.

## Community support and safety

Please read the [Code of Conduct](CODE_OF_CONDUCT.md) and use
[SUPPORT.md](SUPPORT.md) to route product questions, independent test reports,
engine bugs and security vulnerabilities to the right place. Software
vulnerabilities belong in [GitHub's private report flow](https://github.com/B11-Health/aws-emulator-mcp/security/advisories),
not in public issues. We welcome critical technical feedback; disagreement
with maintainers is not a conduct violation.

## Security and coding conventions

- Keep AWS API traffic on verified HTTPS loopback. Never introduce arbitrary endpoint overrides, real AWS credentials, or public network listeners by default.
- Never execute arbitrary shell commands from an MCP tool.
- Bound input size and validate names and types.
- Give each mutation accurate read-only/destructive annotations.
- When creating temporary resources, mint unique names and clean up **only** those resources.
- Test both legacy 2025-11-25 and modern 2026-07-28 MCP semantics. Modern ping does not exist.
- Keep runtime dependencies minimal and explain any new dependency's necessity, license, and threat model.
- Document unsupported operations instead of claiming universal AWS parity.

Before publicizing a security concern, follow [SECURITY.md](SECURITY.md) and use the enabled private vulnerability reporting flow. The project is independent of AWS.
