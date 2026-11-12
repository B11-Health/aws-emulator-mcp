# Contributing to AWS Emulator MCP

Thank you for helping make local cloud experimentation more reliable.

## Reproduce before proposing a feature

1. Install using the README's Windows/WSL or Linux quickstart.
2. Run the unit suite: python3 -m unittest discover -s tests -v
3. Run the independent checker against the actual server in scripts/mcp_launch_check.py.
4. Use a disposable emulator to run scripts/live_test.py.
5. Attach a concise reproduction with the emulator version, MCP protocol version, expected behavior, actual result, and sanitized evidence. Do not include credentials, customer data, or private host paths.

## Good first contributions

- Add one AWS Emulator operation with a strict JSON Schema, tests, and clearly described fidelity limitations.
- Contribute a reproducible emulator API mismatch with minimal synthetic data.
- Improve onboarding across Windows WSL2, Debian/Ubuntu, or an independently verified Docker/macOS route.
- Add a tiny complete workflow demonstrating failure, diagnosis, repair, and scoped cleanup.

## Security and coding conventions

- Keep AWS API traffic on verified HTTPS loopback. Never introduce arbitrary endpoint overrides, real AWS credentials, or public network listeners by default.
- Never execute arbitrary shell commands from an MCP tool.
- Bound input size and validate names and types.
- Give each mutation accurate read-only/destructive annotations.
- When creating temporary resources, mint unique names and clean up **only** those resources.
- Test both legacy 2025-11-25 and modern 2026-07-28 MCP semantics. Modern ping does not exist.
- Keep runtime dependencies minimal and explain any new dependency's necessity, license, and threat model.
- Document unsupported operations instead of claiming universal AWS parity.

Before opening an issue about security, follow SECURITY.md and contact the maintainers privately when an address is available. The project is independent of AWS.
