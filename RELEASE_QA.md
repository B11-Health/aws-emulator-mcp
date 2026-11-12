# Release QA — AWS Emulator MCP 0.2.0

Status: **Local engineering candidate passed; public release not yet approved**.

## Verified on November 12, 2026

- GitHub publishing account: B11-Health. LinkedIn announcement brand: Code Gym.
- Source version: 0.2.0, 25 MCP tools.
- AWS Emulator: official v1.0.322 package previously verified by AWS GPG signature.
- Local unit and security tests: 50/50 passing on Windows Python 3.12 and Ubuntu WSL2 Python 3.12.
- Live integration: 13 service checks plus 4 resource cleanups passed for STS, S3, DynamoDB and SQS using emulator account 000000000000.
- JSON-RPC: legacy 2025-11-25 and modern 2026-07-28 discovery, listing, calling, error handling verified through a real subprocess.
- Windows-to-WSL stdio: modern discovery and 25-tool catalog passed.
- Optional HTTP: authentication, Host/Origin restrictions, protocol checks, response codes and token permissions tested. HTTP test listener was stopped.
- Runtime lifecycle: successfully started and stopped isolated emulator port 9305 without interrupting port 9297.
- Package: standalone Python 3 wheel builds and imports in a clean virtual environment.
- Unit suite includes negative tests for redirect following, malformed requests, type validation and injected cleanup failures.

## Security boundaries

AWS API traffic is fixed to local HTTPS and refuses redirects. Proxy forwarding is disabled. Credentials are drawn only from the emulator's local credentials file. The HTTP listener is opt-in, bound to 127.0.0.1, and gated by bearer token; it is **not** a publicly exposed ChatGPT connector.

## Remaining gates for LinkedIn/public source release

- Publish and independently verify a dedicated public source repository under B11-Health. Do not link the unrelated private codegym Next.js repository.
- Have a separate reviewer run the full test suite, and verify release archive provenance and the published link.
- Update the Code Gym LinkedIn preview video and copy to match the 0.2.0 feature count and tests.
- Avoid claims about production IAM enforcement, all-AWS parity, or direct connection of ChatGPT web to localhost.

No GitHub release or LinkedIn post has been made by this task.
