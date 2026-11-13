#!/usr/bin/env python3
"""Release gate: a packed Node CLI runs a real, network-isolated AWS Emulator.

No cloud credentials, internet access within container, or host port mapping.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
CLI = Path(os.environ.get("CODEGYM_QA_CLI", str(ROOT / "bin" / "codegym-aws.mjs")))
assert CLI.exists()


def run(command, input_data=None, timeout=300, json_mode=False):
    args=["node", str(CLI), command] + (["--json"] if json_mode else [])
    return subprocess.run(args, cwd=ROOT, input=input_data,
                          text=True, capture_output=True, timeout=timeout)


def msg(i, name, args=None):
    return {"jsonrpc": "2.0", "id": i, "method": "tools/call",
            "params": {"name": name, "arguments": args or {}}}


def content(row):
    result = row["result"]
    if result["isError"]:
        raise AssertionError(f"Tool {row['id']} failed: {result['content']}")
    return json.loads(result["content"][0]["text"])


def verify():
    r = run("doctor", json_mode=True)
    assert r.returncode == 0, r.stderr[-1000:]
    doctor = json.loads(r.stdout)
    assert doctor["ready"] and doctor["account_verified"]
    assert len(doctor["checks"]) == 6 and all(v["passed"] for v in doctor["checks"])
    print("DOCKER_DOCTOR_PASS", doctor["emulator_version"], flush=True)

    demo = run("demo", json_mode=True)
    assert demo.returncode == 0, demo.stderr[-800:]
    d = json.loads(demo.stdout)
    assert d["passed"] and len(d["steps"]) >= 12
    assert len(d["recovery"]) == 2 and all(x["passed"] for x in d["recovery"])
    assert len(d["cleanup"]) == 4 and all(x["passed"] for x in d["cleanup"])
    print("DOCKER_ORDER_PASS", d["duration_ms"], flush=True)

    bucket = "cg-sdk-qa-" + uuid.uuid4().hex[:14]
    key = "proof.txt"
    text = "isolated-sdk-model-bridge-verified"
    calls = [
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        msg(2, "aws_sdk_discover", {"service": "s3"}),
        msg(3, "aws_sdk_invoke", {"service": "s3", "operation": "ListBuckets"}),
        msg(4, "aws_sdk_invoke", {"service": "dynamodb", "operation": "ListTables"}),
        msg(5, "aws_sdk_invoke", {"service": "s3", "operation": "CreateBucket",
                                  "parameters": {"Bucket": bucket}}),
        msg(6, "aws_sdk_invoke", {"service": "s3", "operation": "PutObject",
                                  "parameters": {"Bucket": bucket, "Key": key, "Body": text}}),
        msg(7, "aws_sdk_invoke", {"service": "s3", "operation": "GetObject",
                                  "parameters": {"Bucket": bucket, "Key": key}}),
        msg(8, "aws_sdk_invoke", {"service": "s3", "operation": "DeleteObject",
                                  "parameters": {"Bucket": bucket, "Key": key}}),
        msg(9, "aws_sdk_invoke", {"service": "s3", "operation": "DeleteBucket",
                                  "parameters": {"Bucket": bucket}}),
        msg(10, "aws_sdk_invoke", {"service": "s3", "operation": "ListBuckets"}),
        msg(11, "aws_sdk_invoke", {"service": "s3", "operation": "ImpossibleOperation"}),
    ]
    payload = "".join(json.dumps(c, separators=(",", ":")) + "\n" for c in calls)
    r = run("mcp", payload, timeout=100)
    assert r.returncode == 0, r.stderr[-1000:]
    rows = {x["id"]: x for line in r.stdout.splitlines() if line.strip()
            for x in [json.loads(line)]}
    assert len(rows) == len(calls), (rows.keys(), r.stderr[:200])
    tools = rows[1]["result"]["tools"]
    names = {x["name"] for x in tools}
    assert len(tools) == 29
    assert {"aws_sdk_discover", "aws_sdk_invoke", "emulator_order_demo"} <= names
    assert content(rows[2])["modeledOperationCount"] >= 100
    assert content(rows[3])["passed"] and content(rows[4])["passed"]
    for i in range(5, 11):
        assert content(rows[i])["passed"], i
    readback = content(rows[7])["result"]["Body"]
    assert readback["encoding"] == "base64"
    assert base64.b64decode(readback["data"]).decode() == text
    final = content(rows[10])["result"]["Buckets"]
    assert bucket not in [b["Name"] for b in final], "Emulated SDK bucket leaked"
    assert rows[11]["result"]["isError"]
    assert "Operation not present" in rows[11]["result"]["content"][0]["text"]
    print("DOCKER_SDK_PASS", len(tools), "tools, S3 CRUD + cleanup, modeled S3/DDB operations", flush=True)
    print("VERIFIED: no host mounts, ports, AWS account or container external network required", flush=True)


if __name__ == "__main__":
    try:
        verify()
    except Exception as exc:
        print("DOCKER_SMOKE_FAILED", repr(exc), file=sys.stderr)
        sys.exit(1)
