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
        "order-recovery", "s3-recovery", "dynamodb-overwrite",
        "sns-sqs-delivery", "ec2-vpc-lifecycle", "eventbridge-bus",
        "ssm-parameter", "secretsmanager-secret"]
    for experiment in ("s3-recovery", "dynamodb-overwrite",
                       "sns-sqs-delivery", "ec2-vpc-lifecycle",
                       "eventbridge-bus", "ssm-parameter",
                       "secretsmanager-secret"):
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

    coverage = run("coverage", json_mode=True, timeout=140)
    assert coverage.returncode == 0, coverage.stderr[-900:]
    evidence = json.loads(coverage.stdout)
    assert evidence["modeledServiceCount"] >= 400
    assert evidence["totalProbes"] == 20
    assert evidence["successfulProbes"] == 20, evidence
    assert all(row["status"] == "responded" for row in evidence["results"])
    from tempfile import NamedTemporaryFile
    with NamedTemporaryFile(mode="w", suffix=".json", delete=False) as temp:
        temp.write(json.dumps(evidence))
        current = temp.name
    try:
        baseline = ROOT / "docs/evidence/coverage-aws-emulator-1.0.343.json"
        diff = run("coverage-diff", json_mode=True, extra=[str(baseline), current])
        assert diff.returncode == 0, diff.stderr[-900:]
        comparison = json.loads(diff.stdout)
        assert comparison["passed"] and comparison["comparable"]
        assert not comparison["regressions"]
        print("SDK_REGRESSION_DIFF_PASS", comparison["baselineVersion"],
              "vs", comparison["currentVersion"], flush=True)
    finally:
        Path(current).unlink(missing_ok=True)
    print("SDK_COVERAGE_PASS", evidence["successfulProbes"],
          "of", evidence["totalProbes"], "read-only API probes across models",
          evidence["modeledServiceCount"], flush=True)

    app = run("app-debug", json_mode=True, extra=["compare"], timeout=150)
    assert app.returncode == 0, app.stderr[-1000:]
    comparison = json.loads(app.stdout)
    assert comparison["schemaVersion"] == 1
    assert comparison["case"] == "duplicate-order-event"
    assert comparison["passed"] and comparison["bugReproduced"]
    assert comparison["referenceFixVerified"]
    assert comparison["emulatorVersion"] and "Version:" in comparison["emulatorVersion"]
    assert comparison["before"]["passed"] is False
    assert comparison["after"]["passed"] is True
    assert comparison["before"]["observed"]["acceptedSubmissions"] == 2
    assert comparison["before"]["observed"]["queueEvents"] == 2
    assert comparison["after"]["observed"]["acceptedSubmissions"] == 1
    assert comparison["after"]["observed"]["queueEvents"] == 1
    for variant in ("before", "after"):
        assert len(comparison[variant]["cleanup"]) == 7
        assert all(x["passed"] for x in comparison[variant]["cleanup"])
    assert "ConditionExpression" in comparison["referencePatch"]
    from hashlib import sha256
    expected_patch = ROOT / "examples/order-intake/reference.patch"
    assert comparison["referencePatchSha256"] == sha256(expected_patch.read_bytes()).hexdigest()
    print("APPLICATION_DEBUG_PASS", "duplicate events 2 -> 1",
          "cleaned before and after", flush=True)

    failure = run("failure-lab", extra=["compare"], json_mode=True, timeout=180)
    assert failure.returncode == 0, failure.stderr[-1000:]
    proof = json.loads(failure.stdout)
    assert proof["passed"] and proof["missingEventReproduced"]
    assert proof["presendRecoveryVerified"] and proof["lostAckDedupeVerified"]
    for stage, count, effect_count in (
        ("baseline", 0, 0), ("presendRecovery", 1, 1),
        ("lostAckRecovery", 2, 1),
    ):
        data = proof[stage]
        assert data["passed"] and data["verifiedAccount"] == "000000000000"
        assert data["observed"]["firstCallErrorCode"] == "RequestTimeout"
        assert data["observed"]["queueEvents"] == count
        assert data["observed"]["consumerEffectMarkers"] == effect_count
        assert data["observed"]["receiptMatches"] is True
        assert all(item["passed"] for item in data["assertions"])
        assert len(data["cleanup"]) == 7 and all(x["passed"] for x in data["cleanup"])
    assert proof["baseline"]["observed"]["statusAfterFault"] == "queued"
    assert proof["presendRecovery"]["observed"]["statusAfterFault"] == "pending"
    assert proof["lostAckRecovery"]["observed"]["statusAfterFault"] == "pending"
    assert proof["lostAckRecovery"]["observed"]["duplicatesIgnored"] == 1
    assert "injected" in proof["limitations"]
    print("FAILURE_LAB_CLI_PASS", "0 -> 1; lost ack 2 deliveries, one consumer marker",
          "21/21 cleanup", flush=True)

    contract_file = ROOT / "examples/contracts/s3-write-read.json"
    contract = run("contract", extra=["demo"], json_mode=True, timeout=150)
    assert contract.returncode == 0, contract.stderr[-1200:]
    checked = json.loads(contract.stdout)
    assert checked["passed"] and checked["passedSteps"] == checked["totalSteps"] == 3
    assert all(step["passed"] and "responseSha256" in step for step in checked["steps"])
    assert checked["accountVerified"] is True
    assert not any("hello emulator" in str(row) for row in checked["steps"])
    print("CONTRACT_CLI_PASS", checked["passedSteps"], "isolated steps", flush=True)

    for case_id in ("sqs-consume", "ec2-vpc"):
        planfile = ROOT / "examples/contracts" / (case_id + ".json")
        checked_run = run("contract", extra=[str(planfile)], json_mode=True, timeout=150)
        assert checked_run.returncode == 0, checked_run.stderr[-1000:]
        verified = json.loads(checked_run.stdout)
        assert verified["passed"] and verified["passedSteps"] == verified["totalSteps"] == 5
        assert all(row["passed"] for row in verified["steps"])
        print("CONTRACT_LIVE_PASS", case_id, verified["passedSteps"], flush=True)
    architecture_file = ROOT / "examples/architecture/reference/contract.json"
    architecture_run = run(
        "contract", extra=[str(architecture_file)], json_mode=True, timeout=185)
    assert architecture_run.returncode == 0, architecture_run.stderr[-1300:]
    architecture_proof = json.loads(architecture_run.stdout)
    assert architecture_proof["passed"] and architecture_proof["accountVerified"]
    assert architecture_proof["totalSteps"] == architecture_proof["passedSteps"] == 14
    assert {item["service"] for item in architecture_proof["steps"]} == {
        "s3", "dynamodb", "sqs"}
    readiness = next(item for item in architecture_proof["steps"]
                     if item["id"] == "ddbcreate")
    assert readiness["passed"] and readiness["readinessCheck"]["tableActive"]
    assert 1 <= readiness["readinessCheck"]["describeAttempts"] <= 40
    assert architecture_proof["steps"][-1]["id"] == "sqsremove"
    print("ARCHITECTURE_STUDIO_CONTRACT_PASS",
          architecture_proof["passedSteps"], "API steps",
          "DynamoDB readiness", readiness["readinessCheck"]["describeAttempts"], flush=True)

    from tempfile import NamedTemporaryFile
    with NamedTemporaryFile(mode="w", suffix=".json", delete=False) as sample:
        bad_plan = json.loads(contract_file.read_text())
        bad_plan["steps"][-1]["expect"]["assertions"][0]["equals"] = 999
        sample.write(json.dumps(bad_plan))
        invalid_path = sample.name
    try:
        failed_run = run("contract", extra=[invalid_path], json_mode=True, timeout=150)
        assert failed_run.returncode == 1, failed_run.stderr[-800:]
        mismatch = json.loads(failed_run.stdout)
        assert not mismatch["passed"] and mismatch["passedSteps"] == 2
        assert mismatch["steps"][-1]["assertions"][0]["passed"] is False
        print("CONTRACT_EXPECTED_MISMATCH_PASS", flush=True)
    finally:
        Path(invalid_path).unlink(missing_ok=True)

    for mode, template, expected_forwarding in (
        ("before-call", "sqs-before-call", False),
        ("after-success", "sqs-after-success", True),
    ):
        name = "fault-demo" if mode == "after-success" else str(
            ROOT / "examples/contracts" / (template + ".json"))
        res = run("contract", extra=[name], json_mode=True, timeout=150)
        assert res.returncode == 0, res.stderr[-900:]
        proof = json.loads(res.stdout)
        assert proof["passed"] and proof["passedSteps"] == proof["totalSteps"]
        assert proof["accountVerified"] and proof["emulatorVersion"]
        injected = [row for row in proof["steps"] if row["observed"] == "synthetic_sdk_timeout"]
        assert len(injected) == 1
        assert injected[0]["errorCode"] == "RequestTimeout"
        assert injected[0]["fault"]["source"] == "local SDK wrapper"
        assert injected[0]["fault"]["sentToEmulator"] == expected_forwarding
        assert all(row["passed"] for row in proof["steps"])
        print("FAULT_CONTRACT_CLI_PASS", mode, len(proof["steps"]),
              "steps; forwarded", expected_forwarding, flush=True)

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
        msg(14, "aws_sdk_coverage", {"service": "ec2"}),
        msg(15, "aws_sdk_discover", {"service":"ec2", "limit":10, "offset":10, "query":"Describe"}),
        msg(16, "app_debug_catalog"),
        msg(17, "app_debug_run", {"variant":"compare"}),
        msg(18, "app_debug_run", {"variant":"../untrusted"}),
        msg(19, "contract_guide"),
        msg(20, "contract_run", {"plan": json.loads(contract_file.read_text())}),
        msg(21, "contract_run", {"plan": {"schemaVersion":1, "name":"bad", "steps":[{"id":"x","service":"s3","operation":"CreateBucket", "parameters":{"Bucket":{"$shell":"cat /etc/passwd"}}}]}}),
        msg(22, "aws_sdk_invoke", {"service": "s3", "operation": "ListBuckets"}),
        msg(23, "failure_lab_catalog"),
        msg(24, "failure_lab_run", {"scenario": "recover-before-send"}),
        msg(25, "failure_lab_run", {"scenario": "file:///untrusted.py"}),
        msg(26, "contract_run", {"plan": json.loads(
            (ROOT / "examples/contracts/sqs-after-success.json").read_text())}),
        msg(27, "contract_run", {"plan": {
            "schemaVersion": 1, "name": "unsafe", "steps": [{
                "id": "unsafe", "service": "sqs", "operation": "SendMessage",
                "fault": {"mode": "after-success", "command": "curl cloud"},
                "expect": {"errorCode": "RequestTimeout"}
            }]
        }}),
    ]
    payload = "".join(json.dumps(c, separators=(",", ":")) + "\n" for c in calls)
    r = run("mcp", payload, timeout=180)
    assert r.returncode == 0, r.stderr[-1000:]
    rows = {x["id"]: x for line in r.stdout.splitlines() if line.strip()
            for x in [json.loads(line)]}
    assert len(rows) == len(calls), (rows.keys(), r.stderr[:200])
    tools = rows[1]["result"]["tools"]
    names = {x["name"] for x in tools}
    assert len(tools) == 38
    assert {"aws_sdk_discover", "aws_sdk_invoke", "aws_sdk_coverage",
            "emulator_order_demo", "lab_catalog", "lab_run",
            "app_debug_catalog", "app_debug_run",
            "contract_guide", "contract_run",
            "failure_lab_catalog", "failure_lab_run"} <= names
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
    assert len(content(rows[12])["experiments"]) == 8
    proof=content(rows[13])
    assert proof["passed"] and proof["experiment"] == "s3-recovery"
    assert all(x["passed"] for x in proof["cleanup"])
    api_evidence=content(rows[14])
    assert api_evidence["totalProbes"] == 1
    assert api_evidence["results"][0]["status"] == "responded"
    described=content(rows[15])
    assert described["service"] == "ec2" and described["offset"] == 10
    assert described["matchedOperationCount"] > 10
    assert len(described["operations"]) == 10
    assert all("Describe" in row["operation"] for row in described["operations"])

    case = content(rows[16])
    assert case["case"] == "duplicate-order-event"
    assert "def submit_order" in case["buggySource"]
    assert "ConditionExpression" not in case["buggySource"]
    proof = content(rows[17])
    assert proof["passed"] and proof["bugReproduced"] and proof["referenceFixVerified"]
    assert proof["before"]["observed"]["queueEvents"] == 2
    assert proof["after"]["observed"]["queueEvents"] == 1
    assert rows[18]["result"]["isError"]
    assert "Unknown packaged app-debug variant" in rows[18]["result"]["content"][0]["text"]

    assert content(rows[19])["maxSteps"] == 16
    fault_guide = content(rows[19])["faultInjection"]
    assert fault_guide["maxFaultsPerPlan"] == 1
    assert "sqs.SendMessage" in fault_guide["allowedWrites"]
    assert "after-success" in fault_guide["modes"]
    assert "not an emulator/network outage" in fault_guide["meaning"]
    mcp_contract = content(rows[20])
    assert mcp_contract["passed"] and mcp_contract["passedSteps"] == 3
    assert "Dedicated ephemeral" in mcp_contract["isolation"]
    assert all(x["passed"] for x in mcp_contract["steps"])
    assert rows[21]["error"]["code"] == -32602, "untrusted expression must be rejected before execution"

    parent_buckets = content(rows[22])["result"]["Buckets"]
    assert not any(b["Name"].startswith("mcp-contract-") for b in parent_buckets), (
        "Nested contract leaked state into main MCP emulator")
    print("CONTRACT_MCP_PASS", mcp_contract["passedSteps"],
          "fresh nested emulator", flush=True)

    fault_mcp = content(rows[26])
    assert fault_mcp["passed"] and fault_mcp["totalSteps"] == 8
    assert any(step.get("fault", {}).get("sentToEmulator") is True
               for step in fault_mcp["steps"])
    assert rows[27]["error"]["code"] == -32602
    print("FAULT_CONTRACT_MCP_PASS", "agent-authored after-success replay",
          "untrusted fault rejected", flush=True)

    lab_catalog = content(rows[23])
    assert len(lab_catalog["scenarios"]) == 4
    assert "def submit_order" in lab_catalog["fragileSource"]
    assert "pending" in lab_catalog["recoverableSource"]
    assert "--- a/examples/order-intake/fixed/order_service.py" in lab_catalog["sourceDiff"]
    assert "local Python SDK wrapper" in lab_catalog["limitations"]
    lab_evidence = content(rows[24])
    assert lab_evidence["passed"] and lab_evidence["scenario"] == "recover-before-send"
    assert lab_evidence["result"]["observed"]["queueEvents"] == 1
    assert all(item["passed"] for item in lab_evidence["result"]["cleanup"])
    assert rows[25]["error"]["code"] == -32602
    print("FAILURE_LAB_MCP_PASS", "reviewed recovery, untrusted scenario rejected",
          flush=True)

    print("DOCKER_APP_DEBUG_MCP_PASS", "agent-inspectable source, 2 -> 1 events",
          "and strict variant rejection", flush=True)
    print("DOCKER_SDK_PASS", len(tools), "tools, S3 CRUD + cleanup, modeled S3/DDB operations", flush=True)
    print("VERIFIED: no host mounts, ports, AWS account or container external network required", flush=True)


if __name__ == "__main__":
    try:
        verify()
    except Exception as exc:
        print("DOCKER_SMOKE_FAILED", repr(exc), file=sys.stderr)
        sys.exit(1)
