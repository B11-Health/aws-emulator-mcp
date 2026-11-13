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


def discover(service=None):
    m, session_mod, _, _, _ = _runtime()
    session = session_mod.get_session()
    services = session.get_available_services()
    if service is None:
        return {"modeledServiceCount": len(services),
                "sample": services[:45],
                "note": "SDK models are NOT proof an operation is implemented in AWS Emulator; unsupported calls return 501."}
    if service not in services:
        raise m.LocalError("AWS service has no installed SDK model")
    model = session.get_service_model(service)
    names = sorted(model.operation_names)
    sample = []
    for name in names[:35]:
        op = model.operation_model(name)
        required = list(op.input_shape.required_members) if op.input_shape else []
        sample.append({"operation": name, "required": required})
    return {"service": service, "modeledOperationCount": len(names),
            "firstOperations": sample, "note": "Modeled != emulator implemented. Use exact operation names."}


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
