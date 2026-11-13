#!/usr/bin/env bash
# MCP stdout must contain JSON-RPC only. The AWS Emulator never binds off-loopback.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
export AWS_EMULATOR_PORT=9297
mode="${1:-mcp}"
case "$mode" in
  mcp|doctor|demo|self-test|catalog) ;;
  *) echo "Unsupported command: $mode" >&2; exit 2 ;;
esac
if [[ "$mode" == catalog ]]; then
  exec python3 -m aws_emulator_mcp.cli catalog --json
fi
logs="$HOME/.local/share/aws-emulator-mcp"
mkdir -p "$logs"
aws-emulator -p 9297 --telemetry off >"$logs/emulator.log" 2>&1 &
pid=$!
finish() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
trap finish EXIT INT TERM
ready=0
for i in $(seq 1 80); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "AWS Emulator terminated; check startup configuration." >&2
    exit 3
  fi
  if python3 -c 'from aws_emulator_mcp import server; raise SystemExit(0 if server.doctor()["ready"] else 1)' 2>/dev/null; then
    ready=1; break
  fi
  sleep 0.25
done
if [[ "$ready" != 1 ]]; then
  echo "Emulator did not pass local HTTPS and isolated identity checks." >&2
  exit 3
fi
case "$mode" in
  mcp) python3 -u -m aws_emulator_mcp.server ;;
  doctor) python3 -m aws_emulator_mcp.cli doctor --json ;;
  demo) python3 -m aws_emulator_mcp.cli order-demo --json ;;
  self-test) python3 -m aws_emulator_mcp.cli self-test --json ;;
esac
