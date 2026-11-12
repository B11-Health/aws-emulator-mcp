#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
bash "$ROOT/scripts/quickstart_linux.sh" "$ROOT"
python3 "$ROOT/scripts/generate_client_config.py" "$ROOT" --target linux
echo "Linux MCP client config: $ROOT/generated/mcp-client.linux.json"
echo "VS Code config: $ROOT/generated/vscode-mcp.linux.json"
