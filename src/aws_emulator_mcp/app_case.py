"""Developer-approved local Python application scenario against AWS Emulator.

Never expose as MCP or PR/CI action. The source is an explicitly selected,
trusted local Python module sent through stdin into a one-shot, network-disabled
Docker container. It is executable Python: Docker is NOT a hostile-code sandbox.
Independent API checks observe emulator state rather than trusting the
application's own result or assertions. No source, event payload or API body
is returned in evidence.
"""
from __future__ import annotations

from collections import defaultdict
import contextlib
import hashlib
import inspect
import json
import os
import re
import secrets
import sys

from aws_emulator_mcp import app_verify, contract_case, aws_sdk

MAX_ENVELOPE = 96 * 1024
MAX_CASE = 48 * 1024
MAX_STEPS = 16
FUNC = re.compile(r"[A-Za-z_][A-Za-z_0-9]{0,63}\Z")


class AppCaseError(ValueError):
    pass


def _reject(message):
    raise AppCaseError(message)


def validate_case(case):
    if not isinstance(case, dict) or set(case) != {
            "schemaVersion", "name", "services", "setup", "invoke",
            "checks", "cleanup", "regression"}:
        _reject("Case requires schemaVersion, name, services, setup, invoke, checks, cleanup and regression")
    if type(case["schemaVersion"]) is not int or case["schemaVersion"] != 1:
        _reject("Unsupported case schemaVersion")
    if len(contract_case._json_bytes(case)) > MAX_CASE:
        _reject("Case exceeds 48 KiB")
    services = case["services"]
    if (not isinstance(services, list) or not 1 <= len(services) <= 4 or
            any(not isinstance(x, str) or not contract_case.SERVICE.fullmatch(x) for x in services) or
            len(set(services)) != len(services)):
        _reject("Choose 1-4 unique modeled AWS service identifiers")
    for k, maximum in (("setup", 8), ("checks", 8), ("cleanup", 8)):
        if not isinstance(case[k], list) or not 1 <= len(case[k]) <= maximum:
            _reject(k + " must contain 1-8 steps")
    steps = case["setup"] + case["checks"] + case["cleanup"]
    if len(steps) > MAX_STEPS or any(
            step.get("service") not in services or "fault" in step or
            "errorCode" in step.get("expect", {})
            for step in steps if isinstance(step, dict)):
        _reject("Only declared services and successful, fault-free steps are supported")
    contract_case.validate({"schemaVersion": 1, "name": case["name"], "steps": steps})
    # Verify independently observable checks. A test with no assertion cannot
    # be counted as proof of an application's behavior.
    if not any(step.get("expect", {}).get("assertions") for step in case["checks"]):
        _reject("At least one independent post-invocation SDK assertion is required")
    invoke = case["invoke"]
    required_invoke = {"entrypoint", "times", "inputs", "expectedCalls"}
    if not isinstance(invoke, dict) or set(invoke) not in (required_invoke,
                                                          required_invoke | {"fault"}):
        _reject("invoke requires entrypoint, times, inputs and expectedCalls; optional fault")
    if (not isinstance(invoke["entrypoint"], str) or not FUNC.fullmatch(invoke["entrypoint"]) or
            invoke["entrypoint"].startswith("_")):
        _reject("Select a named public Python function")
    if type(invoke["times"]) is not int or not 1 <= invoke["times"] <= 3:
        _reject("invoke times must be 1-3")
    if not isinstance(invoke["inputs"], dict):
        _reject("invoke inputs must be JSON object")
    contract_case._value_ok(invoke["inputs"], {step["id"] for step in case["setup"]})
    expected = invoke["expectedCalls"]
    if not isinstance(expected, list) or not 1 <= len(expected) <= 8:
        _reject("expectedCalls requires 1-8 operation counters")
    seen = set()
    for item in expected:
        if (not isinstance(item, dict) or set(item) != {"service", "operation", "min", "max"} or
                item["service"] not in services or
                not isinstance(item["operation"], str) or
                not contract_case.OPERATION.fullmatch(item["operation"]) or
                type(item["min"]) is not int or type(item["max"]) is not int or
                not 1 <= item["min"] <= item["max"] <= 12):
            _reject("expectedCalls needs valid service, operation and min/max counters")
        identity = item["service"], item["operation"]
        if identity in seen:
            _reject("Duplicate SDK call expectation")
        seen.add(identity)
    if "fault" in invoke:
        fault = invoke["fault"]
        if (not isinstance(fault, dict) or
                set(fault) != {"service", "operation", "mode", "occurrence"} or
                not isinstance(fault.get("service"), str) or
                not isinstance(fault.get("operation"), str) or
                not isinstance(fault.get("mode"), str) or
                (fault["service"], fault["operation"]) not in
                contract_case.FAULTABLE_OPERATIONS or
                fault.get("service") not in services or
                fault.get("mode") not in contract_case.FAULT_MODES or
                type(fault.get("occurrence")) is not int or
                not 1 <= fault["occurrence"] <= 12 or
                not any(x["service"] == fault["service"] and
                        x["operation"] == fault["operation"] and
                        x["max"] >= fault["occurrence"] for x in expected)):
            _reject("One reviewed SDK-boundary fault must target a counted allowlisted write")
    regression = case["regression"]
    if (not isinstance(regression, dict) or set(regression) != {"stepId", "path"} or
            not isinstance(regression["stepId"], str) or
            not isinstance(regression["path"], str)):
        _reject("Select one explicit regression step and assertion path")
    matched = [step for step in case["checks"] if step["id"] == regression["stepId"]]
    if len(matched) != 1 or regression["path"] not in [
            x["path"] for x in matched[0].get("expect", {}).get("assertions", [])]:
        _reject("Regression must reference a real independent post-invocation assertion")
    return case


def validate_envelope(value):
    if not isinstance(value, dict) or set(value) != {
            "schemaVersion", "source", "sourceSha256", "case"}:
        _reject("Expected a source and a reviewed case")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        _reject("Unsupported envelope version")
    app_verify.validate({key: value[key] for key in
                         ("schemaVersion", "source", "sourceSha256")})
    validate_case(value["case"])
    return value


def read_envelope():
    raw = sys.stdin.buffer.read(MAX_ENVELOPE + 1)
    if len(raw) > MAX_ENVELOPE:
        _reject("Application scenario envelope exceeds 96 KiB")
    try:
        value = json.loads(raw.decode("utf-8"),
                           parse_constant=lambda _: _reject("Non-JSON constant"))
    except (UnicodeError, json.JSONDecodeError):
        _reject("Application scenario requires valid UTF-8 JSON")
    return validate_envelope(value)


class AppBoundaryFault:
    """One reviewed, synthetic SDK-boundary timeout; never a network outage."""
    def __init__(self, spec):
        self.spec = spec
        self.attempts_seen = 0
        self.injected = False
        self.sent_to_emulator = False

    def matches(self, service, operation):
        if (service, operation) != (self.spec["service"], self.spec["operation"]):
            return False
        self.attempts_seen += 1
        return self.attempts_seen == self.spec["occurrence"]

    @staticmethod
    def timeout():
        # A botocore transport-style exception *at our wrapper boundary*.
        # The SDK itself did not time out or retry. This tests only the app's
        # explicit exception/recovery branch, not real socket behavior.
        from botocore.exceptions import ReadTimeoutError
        return ReadTimeoutError(endpoint_url="http://127.0.0.1:9297")

    def evidence(self):
        return {"service": self.spec["service"],
                "operation": self.spec["operation"],
                "occurrence": self.spec["occurrence"],
                "mode": self.spec["mode"],
                "attemptsSeen": self.attempts_seen,
                "injected": self.injected,
                "sentToEmulator": self.sent_to_emulator,
                "exceptionType": "ReadTimeoutError",
                "source": "local_sdk_wrapper"}


class ObservedClient:
    """Counts actual calls through injected clients, never stores input data."""
    def __init__(self, service, client, counts, fault=None):
        self._service = service
        self._client = client
        self._counts = counts
        self._fault = fault
        self._methods = client.meta.method_to_api_mapping

    def __getattr__(self, name):
        attr = getattr(self._client, name)
        if not callable(attr) or name not in self._methods:
            return attr
        operation = self._methods[name]
        key = self._service, operation

        def observed(*args, **kwargs):
            self._counts[key][0] += 1
            if self._fault and self._fault.matches(*key):
                if self._fault.spec["mode"] == "before-call":
                    self._fault.injected = True
                    raise self._fault.timeout()
                # The emulator accepted the write but the application does
                # not receive its success response. Never pretend it wrote if
                # the actual SDK call raised first.
                attr(*args, **kwargs)
                self._counts[key][1] += 1
                self._fault.sent_to_emulator = True
                self._fault.injected = True
                raise self._fault.timeout()
            output = attr(*args, **kwargs)
            self._counts[key][1] += 1
            return output
        return observed


def _step(step, responses, fixtures, clients):
    ident, service, operation = (step[key] for key in ("id", "service", "operation"))
    record = {"id": ident, "service": service, "operation": operation,
              "passed": False, "assertions": []}
    expect = step.get("expect", {}).get("assertions", [])
    try:
        params = contract_case._resolve(step.get("parameters", {}), responses, fixtures)
        client = clients[service]
        methods = {v: k for k, v in client.meta.method_to_api_mapping.items()}
        if operation not in methods:
            _reject("Operation not present in installed SDK model")
        output = getattr(client, methods[operation])(**params)
        if service == "dynamodb" and operation == "CreateTable":
            contract_case._wait_created_table_active(client, params["TableName"])
        safe = aws_sdk._safe(output)
        if len(contract_case._json_bytes(safe)) > aws_sdk.MAX_OUTPUT_BYTES:
            _reject("Oversized SDK response")
        responses[ident] = safe
        record["observed"] = "success"
        record["responseSha256"] = hashlib.sha256(contract_case._json_bytes(safe)).hexdigest()
        record["passed"] = True
        for assertion in expect:
            actual = contract_case._at(safe, assertion["path"])
            if "exists" in assertion:
                matched = (actual is not contract_case._MISSING) is assertion["exists"]
            else:
                matched = (actual is not contract_case._MISSING and
                           actual == contract_case._resolve(assertion["equals"], responses, fixtures))
            record["assertions"].append({"path": assertion["path"], "passed": bool(matched)})
            record["passed"] = record["passed"] and bool(matched)
    except Exception as exc:
        code = contract_case._client_error_code(exc)
        record["observed"] = "api_error" if code else "local_error"
        if code:
            record["errorCode"] = code
        else:
            record["errorType"] = type(exc).__name__[:80]
        record["passed"] = False
    return record


def _load_app(source, name):
    namespace = {"__name__": "_selected_local_application"}
    exec(compile(source, "<trusted-local-app>", "exec"), namespace)  # nosec B102
    fn = namespace.get(name)
    if not callable(fn):
        _reject("Selected Python module must define the entrypoint")
    try:
        inspect.signature(fn).bind({}, {})
    except (TypeError, ValueError):
        _reject("Entrypoint must accept (clients, inputs)")
    return fn


def execute(envelope):
    validate_envelope(envelope)
    if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
        _reject("Application execution requires an isolated Docker lab")
    from aws_emulator_mcp import server as aws
    doctor = aws.doctor()
    if not doctor.get("ready") or aws.identity().get("Account") != "000000000000":
        _reject("Only verified isolated AWS Emulator identity may execute local source")
    spec = envelope["case"]
    random_id = secrets.token_hex(6)
    fixtures = {"bucket": "mcp-app-" + random_id, "table": "mcp_app_" + random_id,
                "queue": "mcp_app_" + random_id, "id": "event-" + random_id}
    clients = {service: aws_sdk._client(service)[2] for service in spec["services"]}
    responses = {}
    result = {
        "schemaVersion": 1, "case": spec["name"], "sourceSha256": envelope["sourceSha256"],
        "caseSha256": hashlib.sha256(contract_case._json_bytes(spec)).hexdigest(),
        "emulatorVersion": doctor.get("emulator_version"), "accountVerified": True,
        "sourceInvoked": False, "applicationErrors": False,
        "sourceExecution": "trusted_local_opt_in", "productionAwsValidated": False,
        "setup": [], "checks": [], "cleanup": [], "sdkCalls": [], "expectedCalls": [],
        "passed": False, "applicationInvariantPassed": False, "cleanupPassed": False,
        "dataExposure": "Source, app inputs, SDK request/response bodies, local paths, exception text and logs omitted",
        "scope": "One explicitly selected trusted Python function and independently authored SDK state assertions. "
                 "Not hostile-code isolation, full project test coverage, IAM or AWS production fidelity.",
    }
    counters = defaultdict(lambda: [0, 0])
    fault = AppBoundaryFault(spec["invoke"]["fault"]) if "fault" in spec["invoke"] else None
    # Developer code and all related exceptions stay out of stdout and the
    # machine-readable evidence, even when the selected handler prints logs.
    with open(os.devnull, "w", encoding="utf-8") as sink:
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            for step in spec["setup"]:
                record = _step(step, responses, fixtures, clients)
                result["setup"].append(record)
                if not record["passed"]:
                    break
            if len(result["setup"]) == len(spec["setup"]) and all(
                    step["passed"] for step in result["setup"]):
                try:
                    fn = _load_app(envelope["source"], spec["invoke"]["entrypoint"])
                    resolved = contract_case._resolve(spec["invoke"]["inputs"], responses, fixtures)
                    wrapped = {service: ObservedClient(service, client, counters, fault)
                               for service, client in clients.items()}
                    for _ in range(spec["invoke"]["times"]):
                        result["sourceInvoked"] = True
                        fn(wrapped, resolved)
                except Exception as exc:
                    result["applicationErrors"] = True
                    result["applicationErrorType"] = type(exc).__name__[:80]
                for step in spec["checks"]:
                    record = _step(step, responses, fixtures, clients)
                    result["checks"].append(record)
                    if not record["passed"]:
                        break
            # Best-effort scoped cleanup even after incorrect or exception-
            # raising application logic. Never silently count cleanup as green.
            for step in spec["cleanup"]:
                record = _step(step, responses, fixtures, clients)
                result["cleanup"].append(record)
    if fault is not None:
        result["appFault"] = fault.evidence()
    result["sdkCalls"] = [
        {"service": service, "operation": operation,
         "attempts": count[0], "successes": count[1]}
        for (service, operation), count in sorted(counters.items())]
    for item in spec["invoke"]["expectedCalls"]:
        actual = counters.get((item["service"], item["operation"]), [0, 0])
        result["expectedCalls"].append({
            "service": item["service"], "operation": item["operation"],
            "min": item["min"], "max": item["max"],
            "observed": actual[0], "passed": item["min"] <= actual[0] <= item["max"]})
    result["cleanupPassed"] = len(result["cleanup"]) == len(spec["cleanup"]) and all(
        step["passed"] for step in result["cleanup"])
    result["applicationInvariantPassed"] = (
        result["sourceInvoked"] and not result["applicationErrors"] and
        len(result["setup"]) == len(spec["setup"]) and
        all(step["passed"] for step in result["setup"]) and
        len(result["checks"]) == len(spec["checks"]) and
        all(step["passed"] for step in result["checks"]) and
        all(item["passed"] for item in result["expectedCalls"]) and
        (fault is None or fault.injected))
    result["passed"] = result["applicationInvariantPassed"] and result["cleanupPassed"]
    return result


def main(argv=None):
    if (sys.argv[1:] if argv is None else argv):
        print('{"schemaVersion":1,"passed":false,"error":"Unexpected arguments"}')
        return 2
    try:
        envelope = read_envelope()
        proof = execute(envelope)
        print(json.dumps(proof, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
        return 0 if proof["passed"] else 1
    except Exception:
        # Never echo arbitrary source, input values, private exceptions or logs.
        print('{"schemaVersion":1,"passed":false,"error":"Local application scenario validation or execution failed"}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
