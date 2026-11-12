# AWS Emulator MCP

**An independent, local-first MCP adapter for the official [AWS Emulator](https://github.com/aws/aws-emulator).**

This community adapter is MIT licensed. AWS Emulator is a separate AWS project, distributed under its own license and **not bundled** here. This project is not affiliated with or endorsed by AWS.

**Release identities:** GitHub publisher: [B11-Health](https://github.com/B11-Health). LinkedIn publisher: [Code Gym](https://www.linkedin.com/company/codegympr). Neither link is itself evidence of a published repository for this project.

## Capabilities: 25 local tools

| Category | Tools |
| --- | --- |
| Runtime (4) | emulator_start, emulator_stop, emulator_status, emulator_health |
| Identity (1) | emulator_identity |
| S3 (7) | s3_create_bucket, s3_list_buckets, s3_list_objects, s3_put_object, s3_get_object, s3_delete_object, s3_delete_bucket |
| DynamoDB (6) | dynamodb_create_table, dynamodb_list_tables, dynamodb_describe_table, dynamodb_put_item, dynamodb_get_item, dynamodb_delete_table |
| SQS (6) | sqs_create_queue, sqs_list_queues, sqs_send_message, sqs_receive_messages, sqs_delete_message, sqs_delete_queue |
| Verification (1) | emulator_self_test |

S3 helpers use UTF-8 text. DynamoDB helpers support a PAY_PER_REQUEST table with a string id key and a message string. SQS helpers support standard queues and text messages. These explicit schemas intentionally cover only a subset of each service.

The self-test creates unique local-only resources, checks STS, S3, DynamoDB, and SQS, measures individual latencies, and cleans up only its temporary resources. Failures and incomplete cleanup are reported rather than hidden.

## Quick start: Windows and Ubuntu WSL2

AWS officially documents Docker for Windows. If you already have Ubuntu WSL2, use the provided signed-package installer:

    cd /mnt/c/Users/codeg/mcp-shell-auth/workspace/aws-emulator-mcp
    bash scripts/install_wsl.sh
    python3 -m unittest discover -s tests -v
    python3 scripts/live_test.py

The installer uses a fresh package download to avoid mixing versions of the mutable AWS latest-release URL. It verifies the AWS signing-key fingerprint and detached signature *before* installing. Installation is rootless and side-by-side.

Start the emulator manually, or invoke the emulator_start MCP tool:

    ~/.local/bin/aws-emulator --telemetry off

The emulator is reachable exclusively at local HTTPS 127.0.0.1:9297. No request goes to real AWS.

## Windows MCP client

See the included mcp-windows.json, changing the absolute path as necessary:

    {
      "mcpServers": {
        "aws-emulator-local": {
          "command": "wsl.exe",
          "args": ["-d", "Ubuntu", "--", "bash",
            "/mnt/c/Users/codeg/mcp-shell-auth/workspace/aws-emulator-mcp/scripts/serve_wsl.sh"]
        }
      }
    }

This **stdio transport** is the default. It does not open any additional port.

## Optional authenticated HTTP mode

For MCP clients requiring Streamable HTTP instead of stdio:

    bash scripts/serve_http_wsl.sh

This helper creates a random private bearer token if necessary. The token is stored only in the user's home directory at ~/.config/aws-emulator-mcp/http-token, with owner-only permissions. The listener binds to 127.0.0.1:8766, uses the /mcp path, and requires the token on every request. Nothing starts automatically.

The HTTP transport rejects bad Host and Origin headers, non-JSON content, oversized bodies, and requests without proper authentication. It supports JSON responses and notifications with HTTP 202, not SSE subscriptions or event streams.

**Do not expose this local listener through a public reverse proxy** without a separately audited authentication and authorization layer. ChatGPT web cannot directly reach your machine's localhost address. A secure remote MCP connector would require additional work.

## MCP protocol compatibility

- Handshake-era clients: 2025-03-26, 2025-06-18 and 2025-11-25.
- Modern stateless clients: 2026-07-28, including server/discover, per-request metadata, cache hints, protocol version errors and modern result metadata.
- Errors from malformed JSON-RPC, invalid tool input, unsupported methods and unsupported versions are returned as structured responses.
- Input and output sizes are bounded. The catalog is static. Modern subscriptions and task extensions are not implemented.

See the [MCP specification](https://modelcontextprotocol.io/specification) for version-dependent behavior.

Tool metadata includes read-only and destructive-action annotations so MCP clients can present appropriate precautions. SQS ReceiveMessage is not marked read-only because it changes message visibility.\n\n## Verification

    python3 -m unittest discover -s tests -v
    python3 scripts/live_test.py

As of November 12, 2026, this project passed **50 local unit tests** and an AWS Emulator v1.0.322 integration test in WSL2. The live run exercises both modern and legacy MCP, then performs 13 service checks and four cleanup operations. The test records a dated JSON result under reports/latest_live.json.

The tests validate only those exact behaviors, not production AWS parity or security.

## Security boundaries

- All AWS API operations target HTTPS 127.0.0.1 only, with no endpoint override.
- TLS verifies the per-emulator CA certificate.
- HTTP redirects are denied, and environment proxy settings are ignored.
- The bridge signs requests only with emulator-issued credentials, not your normal AWS profile.
- STS identity verification requires the isolated emulator account 000000000000.
- Tool arguments are validated by type and byte length.
- Runtime stop operations verify their process ownership.
- Adapter-managed emulator startup disables AWS telemetry.
- Optional HTTP transport is loopback-only and bearer authenticated.

AWS Emulator is **not for production security testing** and does not evaluate IAM or resource policies as real AWS does. Resource state is ephemeral. Fidelity varies by service and operation; consult AWS's own evaluation data.

## References

- AWS Emulator: https://github.com/aws/aws-emulator
- AWS Emulator documentation: https://docs.aws.amazon.com/emulator/
- MCP: https://modelcontextprotocol.io/specification
