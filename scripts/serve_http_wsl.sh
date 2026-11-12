#!/usr/bin/env bash
# Opt-in local HTTP transport for native MCP clients.
# Generates a private token if none exists; never prints it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
umask 077
TOKEN_DIR="$HOME/.config/aws-emulator-mcp"
TOKEN_FILE="$TOKEN_DIR/http-token"
mkdir -p "$TOKEN_DIR"
chmod 700 "$TOKEN_DIR"
if [[ ! -s "$TOKEN_FILE" ]]; then
  python3 -c 'import secrets;print(secrets.token_urlsafe(36))' > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
export AWS_MCP_BEARER_TOKEN="$(cat "$TOKEN_FILE")"
export AWS_MCP_HTTP_PORT="8766"
export PYTHONPATH="$ROOT/src"
exec python3 -m aws_emulator_mcp.http_transport
