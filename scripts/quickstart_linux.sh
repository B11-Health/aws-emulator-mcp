#!/usr/bin/env bash
# Fast, repeatable installation for Linux and Windows WSL2.
# Does not expose HTTP, use production credentials, or require root.
set -euo pipefail
if [[ $# -gt 0 ]]; then
  ROOT="$1"
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
ROOT="$(cd "$ROOT" && pwd)"
cd "$ROOT"
export PYTHONPATH="$ROOT/src"
PORT="${AWS_EMULATOR_PORT:-9297}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "Invalid AWS_EMULATOR_PORT: expected 1024..65535" >&2
  exit 2
fi
umask 077

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3.10+ is required. Install python3 before continuing." >&2
  exit 2
fi
python3 -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ required"'

echo "[1/5] Detect official AWS Emulator"
BIN="$HOME/.local/bin/aws-emulator"
if [[ ! -x "$BIN" ]]; then
  BIN="$(command -v aws-emulator || true)"
fi
if [[ -z "$BIN" || ! -x "$BIN" ]]; then
  echo "Official emulator not installed. Downloading the AWS-signed Linux package."
  if ! command -v dpkg-deb >/dev/null 2>&1; then
    echo "Debian/Ubuntu is required for the rootless package installer." >&2
    echo "On RPM-based Linux use AWS's official RPM instructions, then rerun." >&2
    exit 2
  fi
  bash "$ROOT/scripts/install_wsl.sh"
  BIN="$HOME/.local/bin/aws-emulator"
else
  echo "Existing emulator found; skipping download: $BIN"
fi

echo "[2/5] Ensure emulator is running on local HTTPS"
if python3 -c 'from aws_emulator_mcp import server;import sys;sys.exit(0 if server.health()["running"] else 1)' 2>/dev/null; then
  echo "Reusing healthy emulator on 127.0.0.1:$PORT"
else
  LOG_DIR="$HOME/.local/share/aws-emulator-mcp"
  mkdir -p "$LOG_DIR"
  if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    systemd-run --user --unit="aws-emulator-mcp-quickstart-$PORT" --collect "$BIN" -p "$PORT" --telemetry off ||
      { echo "Could not start via systemd user manager." >&2; exit 3; }
  else
    nohup "$BIN" -p "$PORT" --telemetry off > "$LOG_DIR/quickstart-$PORT.log" 2>&1 </dev/null &
    echo "Started detached process PID=$! (may not survive WSL shutdown)"
  fi
  READY=0
  for i in $(seq 1 60); do
    if python3 -c 'from aws_emulator_mcp import server;import sys;sys.exit(0 if server.health()["running"] else 1)' 2>/dev/null; then
      READY=1
      break
    fi
    sleep 0.4
  done
  if [[ "$READY" != 1 ]]; then
    echo "Emulator did not become healthy; check ~/.local/share/aws-emulator-mcp/ logs" >&2
    exit 3
  fi
fi

echo "[3/5] Doctor: local credentials, CA, HTTPS, STS"
python3 -m aws_emulator_mcp.cli doctor

echo "[4/5] End-to-end service test (creates and removes synthetic resources)"
python3 -m aws_emulator_mcp.cli self-test

echo "[5/5] Independent legacy + modern MCP launch smoke test"
python3 "$ROOT/scripts/mcp_launch_check.py" \
  --out "$ROOT/reports/launch_check_latest.json" --min-tools 27 \
  -- python3 -u "$ROOT/src/aws_emulator_mcp/server.py"

echo ""
echo "READY: AWS Emulator MCP local installation verified."
echo "Next: open generated MCP client configuration (see install.ps1 or install.sh)."
