"""Optional broad AWS SDK operation bridge, enabled ONLY inside the isolated Docker lab.

AWS SDK models contain far more operations than the fixed MCP vocabulary.
An operation being modeled does NOT mean the AWS Emulator implements it.
All calls use emulator-issued credentials and verified HTTPS on 127.0.0.1.
"""
from __future__ import annotations
import base64
import datetime
from decimal import Decimal
import json
import os
import re

MAX_INPUT_BYTES = 65536
MAX_OUTPUT_BYTES = 262144


def _runtime():
    from aws_emulator_mcp import server as m
    if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
        raise m.LocalError("Broad SDK operations require the isolated AWS Emulator MCP Docker lab")
    try:
        import botocore.session
        from botocore.config import Config
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as exc:
        raise m.LocalError("Optional botocore SDK models are not installed") from exc
    if not m.doctor()["ready"]:
        raise m.LocalError("Official local AWS Emulator health and identity checks failed")
    return m, botocore.session, Config, BotoCoreError, ClientError


def _client(service):
    m, session_mod, Config, BotoCoreError, ClientError = _runtime()
    if not isinstance(service, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", service):
        raise m.LocalError("Invalid AWS SDK service identifier")
    session = session_mod.get_session()
    if service not in session.get_available_services():
        raise m.LocalError("Service has no installed AWS SDK model: " + service)
    key, secret, token = m.emulator_keys()
    client = session.create_client(
        service, region_name=m.REGION, endpoint_url=m.ENDPOINT,
        verify=str(m.CREDDIR / "ca.pem"),
        aws_access_key_id=key, aws_secret_access_key=secret,
        aws_session_token=token or None,
        config=Config(connect_timeout=4, read_timeout=8,
                      retries={"max_attempts": 0},
                      proxies={}, s3={"addressing_style": "path"})
    )
    return m, session, client, BotoCoreError, ClientError


def _safe(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if (type(value).__module__.startswith("botocore.") and
            type(value).__name__ in ("StreamingBody", "StreamingChecksumBody")):
        # Botocore may wrap streaming HTTP responses in a checksum-verifying
        # reader. Handle both variants without ever returning an open stream.
        try:
            chunk = value.read(MAX_OUTPUT_BYTES + 1)
        finally:
            value.close()
        if len(chunk) > MAX_OUTPUT_BYTES:
            raise ValueError("SDK binary response exceeded 256 KiB")
        return {"encoding": "base64", "data": base64.b64encode(chunk).decode("ascii")}
    if isinstance(value, (bytes, bytearray)):
        return {"encoding": "base64", "data": base64.b64encode(value).decode("ascii")}
    if isinstance(value, (list, tuple)):
        return [_safe(x) for x in value]
    if isinstance(value, dict):
        return {str(k): _safe(v) for k, v in value.items() if k != "ResponseMetadata"}
    raise ValueError("Unexpected SDK response value type: " + type(value).__name__)


# Intentionally small, zero-argument, read-only operations. A PASS means only
# that THIS API call returned successfully from THIS local emulator version.
# No cross-service lifecycle, IAM, pagination, accuracy or AWS parity implied.
READ_ONLY_PROBES = (
    ("sts", "GetCallerIdentity"),
    ("s3", "ListBuckets"),
    ("dynamodb", "ListTables"),
    ("sqs", "ListQueues"),
    ("ec2", "DescribeVpcs"),
    ("lambda", "ListFunctions"),
    ("cloudformation", "ListStacks"),
    ("iam", "ListRoles"),
    ("events", "ListEventBuses"),
    ("sns", "ListTopics"),
    ("secretsmanager", "ListSecrets"),
    ("logs", "DescribeLogGroups"),
    ("apigateway", "GetRestApis"),
    ("stepfunctions", "ListStateMachines"),
    ("bedrock", "ListFoundationModels"),
    ("kms", "ListKeys"),
    ("rds", "DescribeDBInstances"),
    ("ecs", "ListClusters"),
    ("ecr", "DescribeRepositories"),
    ("ssm", "DescribeParameters"),
)


def _page(offset, limit, query):
    if type(offset) is not int or not 0 <= offset <= 20000:
        raise ValueError("offset must be an integer from 0 to 20000")
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("limit must be an integer from 1 to 100")
    if query is not None and (not isinstance(query, str) or
                               len(query) > 64 or not query.strip()):
        raise ValueError("query must be a nonempty search string of at most 64 characters")
    return query.casefold() if query else None


def discover(service=None, offset=0, limit=35, query=None):
    """Page through every modeled service and its operations, not just 45/35.

    This function does not probe APIs. Use coverage() for explicitly bounded
    read-only probes, and upstream AWS fidelity scores for AWS comparisons.
    """
    m, session_mod, _, _, _ = _runtime()
    q = _page(offset, limit, query)
    session = session_mod.get_session()
    services = sorted(session.get_available_services())
    note = ("SDK model availability does NOT mean an operation is implemented "
            "in AWS Emulator or matches AWS; see upstream fidelity reports.")
    if service is None:
        matched = [name for name in services if q is None or q in name.casefold()]
        page = matched[offset:offset + limit]
        return {"modeledServiceCount": len(services),
                "matchedServiceCount": len(matched),
                "offset": offset, "limit": limit,
                "services": page,
                "sample": page,  # backwards-compatible alias
                "nextOffset": offset + len(page) if offset + len(page) < len(matched) else None,
                "note": note}
    if not isinstance(service, str) or service not in services:
        raise m.LocalError("AWS service has no installed SDK model")
    model = session.get_service_model(service)
    names = sorted(model.operation_names)
    matched = [name for name in names if q is None or q in name.casefold()]
    page = matched[offset:offset + limit]
    operations = []
    for name in page:
        op = model.operation_model(name)
        required = list(op.input_shape.required_members) if op.input_shape else []
        operations.append({"operation": name, "required": required,
                           "status": "modeled_not_verified"})
    return {"service": service, "modeledOperationCount": len(names),
            "matchedOperationCount": len(matched),
            "offset": offset, "limit": limit,
            "operations": operations,
            "firstOperations": operations,  # backwards-compatible alias
            "nextOffset": offset + len(page) if offset + len(page) < len(matched) else None,
            "note": note}


def coverage(service=None):
    """Probe an explicit allowlist of read-only local AWS SDK operations.

    This is an operation smoke check and never an AWS fidelity assessment.
    Arbitrary user-requested operations cannot enter this probe path.
    """
    m, session_mod, _, BotoCoreError, ClientError = _runtime()
    session = session_mod.get_session()
    all_models = set(session.get_available_services())
    if service is not None:
        if not isinstance(service, str) or service not in all_models:
            raise m.LocalError("Service has no installed AWS SDK model")
    checks = [item for item in READ_ONLY_PROBES if service is None or item[0] == service]
    results = []
    import time
    for svc, operation in checks:
        tick = time.perf_counter()
        status = "error"
        detail = None
        try:
            _, _, client, BotoCoreError, ClientError = _client(svc)
            method = next(method for method, name in client.meta.method_to_api_mapping.items()
                          if name == operation)
            # Fixed read-only model operation with zero user-supplied parameters.
            getattr(client, method)()
            status = "responded"
        except StopIteration:
            status = "not_modeled"
        except ClientError as exc:
            response = exc.response if isinstance(exc.response, dict) else {}
            code = str(response.get("Error", {}).get("Code", ""))[:80]
            http_status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            status = "not_implemented" if http_status == 501 or code in (
                "NotImplemented", "NotImplementedException", "501") else "api_error"
            detail = code or ("HTTP " + str(http_status) if http_status else "API error")
        except (BotoCoreError, m.LocalError, ValueError, OSError) as exc:
            status = "error"
            detail = type(exc).__name__
        except Exception:
            status = "error"
            detail = "Unexpected local probe failure"
        results.append({"service": svc, "operation": operation,
                        "status": status,
                        "durationMs": round((time.perf_counter() - tick) * 1000, 1),
                        **({"errorClass": detail} if detail else {})})
    successes = sum(r["status"] == "responded" for r in results)
    doctor = m.doctor()
    return {"schemaVersion": 1,
            "emulatorVersion": doctor.get("emulator_version"),
            "modeledServiceCount": len(all_models),
            "probedServiceCount": len({r["service"] for r in results}),
            "successfulProbes": successes,
            "totalProbes": len(results),
            "results": results,
            "service": service,
            "serviceProbeStatus": ("not_probed" if service is not None and not checks else
                                   "probed"),
            "scope": ("Successful responses to selected read-only operations in an "
                      "isolated local AWS Emulator instance. No AWS fidelity or full "
                      "service coverage is inferred from this report."),
            "upstreamFidelity": "https://github.com/aws/aws-emulator/releases"}


def main(argv=None):
    import sys
    args = sys.argv[1:] if argv is None else argv
    if len(args) not in (1, 2) or args[0] != "coverage":
        print("Usage: python -m aws_emulator_mcp.aws_sdk coverage [service]", file=sys.stderr)
        return 2
    try:
        report = coverage(None if len(args) == 1 or args[1] == "all" else args[1])
    except Exception as exc:
        print("Coverage probe failed: " + type(exc).__name__, file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False))
    return 0 if all(r["status"] == "responded" for r in report["results"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())

def invoke(service, operation, parameters=None):
    m, _, client, BotoCoreError, ClientError = _client(service)
    if not isinstance(operation, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9]{0,80}", operation):
        raise m.LocalError("Invalid AWS SDK operation name")
    if parameters is None:
        parameters = {}
    if not isinstance(parameters, dict):
        raise m.LocalError("AWS SDK parameters must be a JSON object")
    try:
        encoded = json.dumps(parameters, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise m.LocalError("Invalid JSON SDK parameters") from exc
    if len(encoded) > MAX_INPUT_BYTES:
        raise m.LocalError("AWS SDK request exceeds 64 KiB")
    names = client.meta.method_to_api_mapping
    methods = {op_name: method for method, op_name in names.items()}
    if operation not in methods:
        raise m.LocalError("Operation not present in the installed AWS SDK model")
    try:
        result = getattr(client, methods[operation])(**parameters)
        try:
            safe = _safe(result)
        except (ValueError, TypeError) as exc:
            raise m.LocalError("SDK operation returned unsupported or oversized data") from exc
        out = {"passed": True, "service": service, "operation": operation,
               "endpoint": m.ENDPOINT, "result": safe,
               "note": "Response is from the local AWS Emulator, not real AWS."}
        if len(json.dumps(out, ensure_ascii=False).encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise m.LocalError("SDK response exceeds 256 KiB")
        return out
    except ClientError as exc:
        error = exc.response.get("Error", {})
        code = str(error.get("Code", "EmulatorError"))[:80]
        raise m.LocalError("Emulated AWS API error (" + code + "); operation not necessarily implemented") from exc
    except BotoCoreError as exc:
        raise m.LocalError("AWS SDK rejected the local request (" + type(exc).__name__ + ")") from exc
