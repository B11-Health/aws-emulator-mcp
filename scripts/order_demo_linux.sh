#!/usr/bin/env bash
set -euo pipefail
if [[ $# -gt 0 ]]; then
  ROOT="$1"
else
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$ROOT"
export PYTHONPATH="$ROOT/src"
mkdir -p "$ROOT/reports"
python3 -m aws_emulator_mcp.cli order-demo --json > "$ROOT/reports/order_demo_latest.json"
python3 - "$ROOT/reports/order_demo_latest.json" <<'PY'
import json,sys
from pathlib import Path
path=Path(sys.argv[1]);data=json.loads(path.read_text())
print("Order ID:",data["order_id"])
print("Synthetic order:",data["synthetic_order"])
print("Workflow checks:",len(data["steps"]))
print("Failure and recovery:",len(data["recovery"]))
print("Resources cleaned:",sum(bool(x["passed"]) for x in data["cleanup"]))
print("Duration ms:",data["duration_ms"])
print("Full evidence:",path)
if not data["passed"]:
    print("FAILED:",data.get("error"))
    sys.exit(1)
print("PASS: no live AWS resources created")
PY
