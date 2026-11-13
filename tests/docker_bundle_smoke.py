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
CLI = Path(os.environ.get("AWS_EMULATOR_MCP_QA_CLI", str(ROOT / "bin" / "aws-emulator-mcp.mjs")))
assert CLI.exists()


def run(command, input_data=None, timeout=300, json_mode=False, extra=None):
    args=["node", str(CLI), command] + (extra or []) + (["--json"] if json_mode else [])
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

    labs = run("experiments", json_mode=True)
    assert labs.returncode == 0, labs.stderr[-800:]
    available = json.loads(labs.stdout)
    assert [x["id"] for x in available["experiments"]] == [
        "order-recovery", "s3-recovery", "dynamodb-overwrite"]
    for experiment in ("s3-recovery", "dynamodb-overwrite"):
        attempt = run("experiment", extra=[experiment], json_mode=True, timeout=120)
        assert attempt.returncode == 0, attempt.stderr[-800:]
        proof = json.loads(attempt.stdout)
        assert proof["passed"] and proof["schemaVersion"] == 1
        assert proof["verifiedAccount"] == "000000000000"
        assert all(row["passed"] for row in proof["steps"] + proof["cleanup"])
        assert len(proof["cleanup"]) >= 2
        if experiment == "s3-recovery":
            assert len(proof["expectedFailures"]) == 1
            assert proof["expectedFailures"][0]["observed"] == "HTTP 404"
        print("EXPERIMENT_PASS", experiment, len(proof["steps"]),
              "assertions", len(proof["cleanup"]), "cleanup checks", flush=True)

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
        msg(12, "lab_catalog"),
        msg(13, "lab_run", {"experiment": "s3-recovery"}),
    ]
    payload = "".join(json.dumps(c, separators=(",", ":")) + "\n" for c in calls)
    r = run("mcp", payload, timeout=100)
    assert r.returncode == 0, r.stderr[-1000:]
    rows = {x["id"]: x for line in r.stdout.splitlines() if line.strip()
            for x in [json.loads(line)]}
    assert len(rows) == len(calls), (rows.keys(), r.stderr[:200])
    tools = rows[1]["result"]["tools"]
    names = {x["name"] for x in tools}
    assert len(tools) == 31
    assert {"aws_sdk_discover", "aws_sdk_invoke", "emulator_order_demo", "lab_catalog", "lab_run"} <= names
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
    assert len(content(rows[12])["experiments"]) == 3
    proof=content(rows[13])
    assert proof["passed"] and proof["experiment"] == "s3-recovery"
    assert all(x["passed"] for x in proof["cleanup"])

    print("DOCKER_SDK_PASS", len(tools), "tools, S3 CRUD + cleanup, modeled S3/DDB operations", flush=True)
    print("VERIFIED: no host mounts, ports, AWS account or container external network required", flush=True)


if __name__ == "__main__":
    try:
        verify()
    except Exception as exc:
        print("DOCKER_SMOKE_FAILED", repr(exc), file=sys.stderr)
        sys.exit(1)
