"""Replayable, declarative AWS SDK contracts in fresh, isolated emulators.

No scripts, file mounts, caller credentials, arbitrary endpoints, or AWS account.
Each MCP request launches a distinct local emulator on a random loopback port.
The CLI runs the same contract inside its one-shot network-isolated container.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time

MAX_PLAN_BYTES = 48 * 1024
MAX_STEPS = 16
MAX_REPORT_BYTES = 96 * 1024
IDENTIFIER = re.compile(r"[a-z][a-z0-9_-]{0,31}\Z")
SERVICE = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
OPERATION = re.compile(r"[A-Z][A-Za-z0-9]{0,79}\Z")
PATH = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]{1,3})){0,9}\Z")
ERROR_CODE = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,79}\Z")
FIXTURES = ("bucket", "table", "queue", "id")
FAULT_MODES = ("before-call", "after-success")
FAULTABLE_OPERATIONS = frozenset({
    ("sqs", "SendMessage"), ("s3", "PutObject"),
    ("dynamodb", "PutItem"),
})
FAULT_ERROR_CODE = "RequestTimeout"
# One bounded, synthetic SDK-boundary timeout per contract. Not a real outage.


# This is a metadata-only example. No emulator/SDK call in guide().
EXAMPLE = {
    "schemaVersion": 1,
    "name": "s3-write-read",
    "steps": [
        {"id": "create", "service": "s3", "operation": "CreateBucket",
         "parameters": {"Bucket": {"$fixture": "bucket"}}},
        {"id": "put", "service": "s3", "operation": "PutObject",
         "parameters": {"Bucket": {"$fixture": "bucket"}, "Key": "hello.txt",
                        "Body": "hello emulator"}},
        {"id": "read", "service": "s3", "operation": "GetObject",
         "parameters": {"Bucket": {"$fixture": "bucket"}, "Key": "hello.txt"},
         "expect": {"assertions": [
             {"path": "ContentLength", "equals": 14},
             {"path": "Body.encoding", "equals": "base64"}]}}
    ]
}


# A contract may describe SDK retry behavior without executing developer code.
FAULT_EXAMPLES = {
    "sqs-before-call": {
        "schemaVersion": 1, "name": "sqs-before-send-retry",
        "steps": [
            {"id": "queue", "service": "sqs", "operation": "CreateQueue",
             "parameters": {"QueueName": {"$fixture": "queue"}},
             "expect": {"assertions": [{"path": "QueueUrl", "exists": True}]}},
            {"id": "timeout", "service": "sqs", "operation": "SendMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "MessageBody": "sample-retry-event"},
             "fault": {"mode": "before-call"},
             "expect": {"errorCode": FAULT_ERROR_CODE}},
            {"id": "empty", "service": "sqs", "operation": "ReceiveMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "MaxNumberOfMessages": 1},
             "expect": {"assertions": [{"path": "Messages", "exists": False}]}},
            {"id": "retry", "service": "sqs", "operation": "SendMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "MessageBody": "sample-retry-event"},
             "expect": {"assertions": [{"path": "MessageId", "exists": True}]}},
            {"id": "received", "service": "sqs", "operation": "ReceiveMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "MaxNumberOfMessages": 1},
             "expect": {"assertions": [
                 {"path": "Messages.0.Body", "equals": "sample-retry-event"}]}},
            {"id": "ack", "service": "sqs", "operation": "DeleteMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "ReceiptHandle": {"$ref": "received.Messages.0.ReceiptHandle"}}},
            {"id": "remove", "service": "sqs", "operation": "DeleteQueue",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"}}},
        ],
    },
    "sqs-after-success": {
        "schemaVersion": 1, "name": "sqs-lost-ack-retry",
        "steps": [
            {"id": "queue", "service": "sqs", "operation": "CreateQueue",
             "parameters": {"QueueName": {"$fixture": "queue"}},
             "expect": {"assertions": [{"path": "QueueUrl", "exists": True}]}},
            {"id": "lostack", "service": "sqs", "operation": "SendMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "MessageBody": "sample-retry-event"},
             "fault": {"mode": "after-success"},
             "expect": {"errorCode": FAULT_ERROR_CODE}},
            {"id": "retry", "service": "sqs", "operation": "SendMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "MessageBody": "sample-retry-event"},
             "expect": {"assertions": [{"path": "MessageId", "exists": True}]}},
            {"id": "first", "service": "sqs", "operation": "ReceiveMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "MaxNumberOfMessages": 1},
             "expect": {"assertions": [
                 {"path": "Messages.0.Body", "equals": "sample-retry-event"}]}},
            {"id": "ackfirst", "service": "sqs", "operation": "DeleteMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "ReceiptHandle": {"$ref": "first.Messages.0.ReceiptHandle"}}},
            {"id": "second", "service": "sqs", "operation": "ReceiveMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "MaxNumberOfMessages": 1},
             "expect": {"assertions": [
                 {"path": "Messages.0.Body", "equals": "sample-retry-event"}]}},
            {"id": "acksecond", "service": "sqs", "operation": "DeleteMessage",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"},
                            "ReceiptHandle": {"$ref": "second.Messages.0.ReceiptHandle"}}},
            {"id": "remove", "service": "sqs", "operation": "DeleteQueue",
             "parameters": {"QueueUrl": {"$ref": "queue.QueueUrl"}}},
        ],
    },
}


class InjectedSdkTimeout(Exception):
    """Local control-plane fault; never report as an error from AWS Emulator."""
    def __init__(self, mode):
        super().__init__("synthetic SDK-boundary timeout")
        self.mode = mode


def _error(message):
    from aws_emulator_mcp.server import LocalError
    raise LocalError(message)


def _json_bytes(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":"), sort_keys=True).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        _error("Contract must contain bounded JSON values only")


def _is_reference(value):
    return (isinstance(value, dict) and len(value) == 1
            and next(iter(value)) in ("$fixture", "$ref"))


def _value_ok(value, earlier, depth=0):
    if depth > 12:
        _error("Contract values are nested too deeply")
    if _is_reference(value):
        key, data = next(iter(value.items()))
        if not isinstance(data, str):
            _error("Contract references must be strings")
        if key == "$fixture":
            if data not in FIXTURES:
                _error("Unknown contract fixture")
        else:
            pieces = data.split(".", 1)
            if len(pieces) != 2 or pieces[0] not in earlier or not PATH.fullmatch(pieces[1]):
                _error("Contract can reference only a previous successful step's result path")
        return
    if isinstance(value, dict):
        if len(value) > 80:
            _error("Contract object has too many members")
        for key, item in value.items():
            if not isinstance(key, str) or len(key) > 100 or key.startswith("$"):
                _error("Unsupported contract key or expression")
            _value_ok(item, earlier, depth + 1)
    elif isinstance(value, list):
        if len(value) > 100:
            _error("Contract array is too long")
        for item in value:
            _value_ok(item, earlier, depth + 1)
    elif value is not None and type(value) not in (str, int, float, bool):
        _error("Only JSON literals, $fixture and $ref are allowed")
    elif isinstance(value, str) and len(value.encode("utf-8")) > 8192:
        _error("Contract scalar exceeds 8 KiB")


def validate(plan):
    """Validate the full plan before any emulator process or API call."""
    if not isinstance(plan, dict) or set(plan) != {"schemaVersion", "name", "steps"}:
        _error("Contract requires schemaVersion, name and steps only")
    if type(plan["schemaVersion"]) is not int or plan["schemaVersion"] != 1:
        _error("Unsupported contract schemaVersion")
    if not isinstance(plan["name"], str) or not 1 <= len(plan["name"]) <= 80:
        _error("Contract name must have 1-80 characters")
    steps = plan["steps"]
    if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_STEPS:
        _error("Contract must contain 1-16 steps")
    if len(_json_bytes(plan)) > MAX_PLAN_BYTES:
        _error("Contract exceeds 48 KiB")
    earlier = set()
    seen = set()
    injected = 0
    for step in steps:
        if not isinstance(step, dict) or set(step) - {"id", "service", "operation", "parameters", "expect", "fault"}:
            _error("Contract step contains unknown fields")
        if any(k not in step for k in ("id", "service", "operation")):
            _error("Contract step requires id, service and operation")
        ident, service, operation = (step[k] for k in ("id", "service", "operation"))
        if not isinstance(ident, str) or not IDENTIFIER.fullmatch(ident) or ident in seen:
            _error("Contract step id is invalid or repeated")
        if not isinstance(service, str) or not SERVICE.fullmatch(service):
            _error("Invalid modeled service identifier")
        if not isinstance(operation, str) or not OPERATION.fullmatch(operation):
            _error("Invalid modeled API operation")
        fault = step.get("fault")
        if "fault" in step:
            injected += 1
            if injected > 1:
                _error("Only one SDK-boundary fault is permitted per contract")
            if (not isinstance(fault, dict) or set(fault) != {"mode"}
                    or fault.get("mode") not in FAULT_MODES):
                _error("Fault must select before-call or after-success only")
            if (service, operation) not in FAULTABLE_OPERATIONS:
                _error("Fault injection is restricted to allowlisted SDK writes")
            if step.get("expect") != {"errorCode": FAULT_ERROR_CODE}:
                _error("A fault step must explicitly expect RequestTimeout")
        params = step.get("parameters", {})
        if not isinstance(params, dict):
            _error("Contract step parameters must be an object")
        _value_ok(params, earlier)
        expect = step.get("expect", {})
        if not isinstance(expect, dict) or set(expect) - {"errorCode", "assertions"}:
            _error("Invalid contract expectation fields")
        if "errorCode" in expect:
            code = expect["errorCode"]
            if (not isinstance(code, str) or not ERROR_CODE.fullmatch(code)
                    or expect.get("assertions")):
                _error("Expected errorCode must be a valid API code with no assertions")
        assertions = expect.get("assertions", [])
        if not isinstance(assertions, list) or len(assertions) > 10:
            _error("Contract supports up to 10 assertions per step")
        for assertion in assertions:
            if not isinstance(assertion, dict) or set(assertion) not in (
                    {"path", "equals"}, {"path", "exists"}):
                _error("Each assertion needs path and exactly one equals or exists")
            if not isinstance(assertion["path"], str) or not PATH.fullmatch(assertion["path"]):
                _error("Invalid assertion path")
            if "exists" in assertion:
                if type(assertion["exists"]) is not bool:
                    _error("exists must be a boolean")
            else:
                _value_ok(assertion["equals"], earlier)
        seen.add(ident)
        if "errorCode" not in expect:
            earlier.add(ident)  # Error steps have no successful result to reference.
    return plan


def guide():
    return {
        "schemaVersion": 1, "tool": "contract_run", "maxSteps": MAX_STEPS,
        "fixtures": list(FIXTURES), "example": EXAMPLE,
        "faultInjection": {
            "maxFaultsPerPlan": 1, "modes": list(FAULT_MODES),
            "allowedWrites": [service + "." + operation
                              for service, operation in sorted(FAULTABLE_OPERATIONS)],
            "example": {"fault": {"mode": "after-success"},
                        "expect": {"errorCode": FAULT_ERROR_CODE}},
            "meaning": "before-call never invokes the chosen operation. "
                       "after-success invokes it on the local emulator and suppresses "
                       "the successful SDK acknowledgement. This is a synthetic "
                       "SDK-boundary timeout, not an emulator/network outage.",
            "safety": "No scripts, user source execution, hosts, endpoints, "
                      "fault scheduling, loops or arbitrary error codes.",
            "templates": FAULT_EXAMPLES,
        },
        "syntax": {
            "parameters": "Standard modeled botocore API JSON parameters",
            "fixture": {"$fixture": "bucket"},
            "reference": {"$ref": "priorStep.QueueUrl"},
            "assertion": {"path": "QueueUrl", "exists": True},
            "expectedFailure": {"errorCode": "NoSuchBucket"}},
        "isolation": "Fresh local loopback emulator and temporary HOME per MCP run; "
                     "CLI uses a one-shot network-disabled Docker container.",
        "outputs": "Per-step pass/fail and response SHA-256; never raw response bodies.",
        "limits": "Modeled APIs may be unimplemented. Not AWS parity or IAM validation. "
                  "Use synthetic data; no arbitrary scripts, cloud credentials or network."}


_MISSING = object()


def _at(data, path):
    current = data
    for token in path.split("."):
        if isinstance(current, dict):
            current = current.get(token, _MISSING)
        elif isinstance(current, list) and token.isdecimal():
            index = int(token)
            current = current[index] if index < len(current) else _MISSING
        else:
            return _MISSING
        if current is _MISSING:
            return _MISSING
    return current


def _resolve(value, responses, fixtures):
    if _is_reference(value):
        key, source = next(iter(value.items()))
        if key == "$fixture":
            return fixtures[source]
        ident, path = source.split(".", 1)
        resolved = _at(responses.get(ident, {}), path)
        if resolved is _MISSING:
            _error("Prior step response path was unavailable: " + ident + "." + path)
        return resolved
    if isinstance(value, dict):
        return {key: _resolve(item, responses, fixtures) for key, item in value.items()}
    if isinstance(value, list):
        return [_resolve(item, responses, fixtures) for item in value]
    return value


def _client_error_code(exc):
    response = getattr(exc, "response", {})
    if not isinstance(response, dict) or not isinstance(response.get("Error"), dict):
        return None
    code = response["Error"].get("Code", "")
    return code if isinstance(code, str) and ERROR_CODE.fullmatch(code) else "EmulatorError"


def execute(plan):
    """Execute only against the verified local emulator; produce redacted evidence."""
    validate(plan)
    if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
        _error("Contract execution requires an isolated Docker lab")
    from aws_emulator_mcp import server as aws, aws_sdk
    if not aws.doctor()["ready"] or aws.identity().get("Account") != "000000000000":
        _error("Refusing contract without verified isolated emulator identity")
    suffix = secrets.token_hex(6)
    fixtures = {
        "bucket": "mcp-contract-" + suffix, "table": "mcp_contract_" + suffix,
        "queue": "mcp_contract_" + suffix, "id": "record-" + suffix,
    }
    report = {
        "schemaVersion": 1, "name": plan["name"], "passed": False,
        "emulatorVersion": aws.doctor().get("emulator_version"),
        "accountVerified": True,
        "planSha256": hashlib.sha256(_json_bytes(plan)).hexdigest(),
        "steps": [], "passedSteps": 0, "totalSteps": len(plan["steps"]),
        "dataExposure": "No request parameters or response payloads returned",
        "scope": "Local AWS Emulator SDK behavior only; not AWS or IAM fidelity",
    }
    responses = {}
    for step in plan["steps"]:
        tick = time.perf_counter()
        record = {"id": step["id"], "service": step["service"],
                  "operation": step["operation"], "passed": False,
                  "assertions": []}
        report["steps"].append(record)
        expected = step.get("expect", {})
        try:
            params = _resolve(step.get("parameters", {}), responses, fixtures)
            _, _, client, _, _ = aws_sdk._client(step["service"])
            mapping = {api: method for method, api in client.meta.method_to_api_mapping.items()}
            if step["operation"] not in mapping:
                _error("SDK operation is not modeled")
            fault = step.get("fault")
            if fault and fault["mode"] == "before-call":
                raise InjectedSdkTimeout("before-call")
            output = getattr(client, mapping[step["operation"]])(**params)
            if fault and fault["mode"] == "after-success":
                raise InjectedSdkTimeout("after-success")
            safe = aws_sdk._safe(output)
            if len(_json_bytes(safe)) > 262144:
                _error("Contract SDK response exceeds 256 KiB")
            responses[step["id"]] = safe
            record["observed"] = "success"
            record["responseSha256"] = hashlib.sha256(_json_bytes(safe)).hexdigest()
            record["passed"] = "errorCode" not in expected
            for item in expected.get("assertions", []):
                actual = _at(safe, item["path"])
                if "exists" in item:
                    matched = (actual is not _MISSING) == item["exists"]
                else:
                    matched = (actual is not _MISSING and
                               actual == _resolve(item["equals"], responses, fixtures))
                record["assertions"].append({"path": item["path"], "passed": bool(matched)})
                record["passed"] = record["passed"] and bool(matched)
        except InjectedSdkTimeout as exc:
            record["observed"] = "synthetic_sdk_timeout"
            record["errorCode"] = FAULT_ERROR_CODE
            record["fault"] = {
                "mode": exc.mode,
                "sentToEmulator": exc.mode == "after-success",
                "source": "local SDK wrapper",
            }
            record["passed"] = expected.get("errorCode") == FAULT_ERROR_CODE
        except Exception as exc:
            code = _client_error_code(exc)
            record["observed"] = "api_error" if code else "local_error"
            if code:
                record["errorCode"] = code
            else:
                # No exception messages, URLs, secrets, request bodies or tracebacks.
                record["errorType"] = type(exc).__name__[:80]
            record["passed"] = bool(not step.get("fault")
                                    and code and code == expected.get("errorCode"))
        record["durationMs"] = round((time.perf_counter() - tick) * 1000, 1)
        if record["passed"]:
            report["passedSteps"] += 1
        else:
            break  # Never run dependent steps after an unexpected result.
    report["passed"] = report["passedSteps"] == report["totalSteps"]
    return report


def _read_stdin():
    raw = sys.stdin.buffer.read(MAX_PLAN_BYTES + 1)
    if len(raw) > MAX_PLAN_BYTES:
        _error("Contract input exceeds 48 KiB")
    try:
        obj = json.loads(raw, parse_constant=lambda _: _error("Invalid JSON constant"))
    except (json.JSONDecodeError, UnicodeError):
        _error("Contract is not valid UTF-8 JSON")
    return validate(obj)


def _wait_ready():
    from aws_emulator_mcp import server as aws
    for _ in range(80):
        if aws.health().get("running"):
            try:
                if aws.identity().get("Account") == "000000000000":
                    return
            except (aws.LocalError, OSError, ValueError):
                pass
        time.sleep(0.25)
    _error("Dedicated local AWS Emulator failed readiness check")


def _child_execute():
    from aws_emulator_mcp import server as aws
    try:
        plan = _read_stdin()
        _wait_ready()
        proof = execute(plan)
        output = _json_bytes(proof)
        if len(output) > MAX_REPORT_BYTES:
            _error("Contract evidence exceeds output limit")
        sys.stdout.buffer.write(output + b"\n")
        return 0 if proof["passed"] else 1
    except (aws.LocalError, ValueError, OSError):
        sys.stdout.write(json.dumps({"schemaVersion": 1, "passed": False,
                                     "error": "Contract validation, emulator startup or execution failed"}) + "\n")
        return 2


def run(plan):
    """MCP entry: a new independent emulator process, no access to main MCP state."""
    validate(plan)  # before any process is started
    if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
        _error("Contract runner is Docker-only")
    from aws_emulator_mcp import server as aws
    if not aws.doctor()["ready"] or aws.identity().get("Account") != "000000000000":
        _error("Contract runner requires verified isolated main Docker lab")
    binary = aws.emulator_binary()
    if not binary:
        _error("Official AWS Emulator binary is unavailable")
    with tempfile.TemporaryDirectory(prefix="aws-mcp-contract-") as home:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = {key: os.environ[key] for key in
               ("PATH", "PYTHONPATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE")
               if key in os.environ}
        env.update(HOME=home, AWS_EMULATOR_PORT=str(port),
                   AWS_EMULATOR_MCP_ISOLATED_LAB="1")
        with open(Path(home) / "emulator.log", "wb") as log:
            process = subprocess.Popen(
                [binary, "-p", str(port), "--telemetry", "off"],
                cwd=home, env=env, stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                result = subprocess.run(
                    [sys.executable, "-m", "aws_emulator_mcp.contract_case", "execute"],
                    input=_json_bytes(plan), capture_output=True,
                    env=env, cwd=home, timeout=125, check=False)
                if len(result.stdout) > MAX_REPORT_BYTES:
                    _error("Contract worker returned oversized evidence")
                try:
                    proof = json.loads(result.stdout)
                except (ValueError, UnicodeError):
                    _error("Contract worker failed without structured evidence")
                if not isinstance(proof, dict) or type(proof.get("passed")) is not bool:
                    _error("Contract worker evidence is invalid")
                proof["isolation"] = "Dedicated ephemeral loopback emulator; process and state discarded"
                return proof
            except subprocess.TimeoutExpired:
                _error("Contract worker exceeded 125-second bounded execution")
            finally:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)


if __name__ == "__main__":
    if sys.argv[1:] != ["execute"]:
        raise SystemExit(2)
    raise SystemExit(_child_execute())
