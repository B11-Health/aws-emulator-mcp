"""Inspect Botocore's local model and check candidate JSON without creating a client."""
from __future__ import annotations

import os
import re

from . import aws_sdk


def _child(shape, part):
    if shape is not None:
        if shape.type_name == "structure" and part in shape.members:
            return shape.members[part]
        if part == "*" and shape.type_name == "list":
            return shape.member
        if part == "*" and shape.type_name == "map":
            return shape.value
    raise ValueError("Unknown model path. Inspect its parent and use * for a list item or map value.")


def _describe(shape, path, offset, limit):
    if shape is None:
        return {"path": path, "type": "none"}
    result = {"path": path, "type": shape.type_name, "shapeName": shape.name}
    result.update({k: shape.metadata[k] for k in ("min", "max") if k in shape.metadata})
    if shape.type_name == "structure":
        if shape.is_document_type:
            return {**result, "document": True}
        if shape.is_tagged_union:
            result["exactlyOneMember"] = True
        required = set(shape.required_members)
        names = sorted(shape.members, key=lambda n: (n not in required, n))
        result["members"] = [
            {"name": name, "type": shape.members[name].type_name, "required": name in required}
            for name in names[offset:offset + limit]
        ]
    elif shape.type_name in ("map", "list"):
        result["itemPath"] = (path + "." if path else "") + "*"
        result["itemType"] = _child(shape, "*").type_name
        if shape.type_name == "map":
            result["keyType"] = shape.key.type_name
        return result
    elif shape.metadata.get("enum"):
        names = shape.metadata["enum"]
        result["enum"] = names[offset:offset + limit]
    else:
        return result
    result.update(total=len(names), nextOffset=offset + limit if offset + limit < len(names) else None)
    return result


def _diagnostic_path(location, shape, value):
    """Translate an SDK error path to model members. Map keys and indices stay private."""
    path = []
    while location and shape is not None:
        if shape.type_name == "map":
            path.append("*")
            if not isinstance(value, dict) or not location.startswith("."):
                return path, None
            suffix = location[1:]
            # SDK diagnostic paths do not escape map keys. Stop at the map if
            # two caller keys could both explain the same dotted SDK path.
            keys = [k for k in value if suffix == k or suffix.startswith((k + ".", k + "["))]
            if len(keys) != 1:
                return path, None
            key = keys[0]
            location, value, shape = suffix[len(key):], value[key], shape.value
        elif shape.type_name == "list":
            index = re.match(r"^\[(\d+)\]", location)
            if not index or not isinstance(value, list) or int(index[1]) >= len(value):
                return path, None
            path.append("*")
            location, value, shape = location[index.end():], value[int(index[1])], shape.member
        else:
            field = re.match(r"^\.([A-Za-z0-9_]+)", location)
            if shape.type_name != "structure" or not field or field[1] not in shape.members:
                return path, None
            name = field[1]
            path.append(name)
            location, shape = location[field.end():], shape.members[name]
            value = value.get(name) if isinstance(value, dict) else None
    return path, shape


def check_input(parameters, shape):
    from botocore.validate import ParamValidator

    if shape is None:
        issues = [{"path": "", "reason": "operation has no input"}] if parameters else []
        return {"valid": not issues, "issueCount": len(issues), "issues": issues}
    errors = ParamValidator().validate(parameters, shape)
    # Botocore 1.44.2's rendered report includes raw values and map keys.
    # Its structured records let us return only model-owned names and types.
    issues = []
    for reason, location, details in errors._errors[:12]:
        parts, member = _diagnostic_path(location, shape, parameters)
        if reason == "missing required field" and member and member.type_name == "structure":
            name = details["required_name"]
            if name in member.members:
                parts.append(name)
                member = member.members[name]
        issue = {"path": ".".join(parts), "reason": reason}
        if member is not None:
            issue["modelType"] = member.type_name
        issues.append(issue)
    return {"valid": not errors.has_errors(), "issueCount": len(errors._errors), "issues": issues}


def preview(service, operation, direction="input", path="", offset=0, limit=35, parameters=None):
    if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
        raise ValueError("SDK request preview requires the isolated lab's installed models")
    from botocore import __version__ as sdk_version
    from botocore.session import get_session

    aws_sdk._page(offset, limit, None)
    if direction not in ("input", "output"):
        raise ValueError("direction must be input or output")
    if not isinstance(path, str) or len(path) > 512 or (path and len(path.split(".")) > 32):
        raise ValueError("Model path exceeds the limit")
    if parameters is not None:
        aws_sdk.check_parameters(parameters)
    session = get_session()
    if service not in session.get_available_services():
        raise ValueError("Service has no installed AWS SDK model")
    model = session.get_service_model(service)
    if operation not in model.operation_names:
        raise ValueError("Unknown operation. Use aws_sdk_discover to look up its exact name.")
    op = model.operation_model(operation)
    shape = op.input_shape if direction == "input" else op.output_shape
    for part in path.split(".") if path else ():
        shape = _child(shape, part)
    report = {"service": service, "operation": operation, "sdkVersion": sdk_version,
              "direction": direction, "schema": _describe(shape, path, offset, limit),
              "status": "modeled_not_verified", "operationExecuted": False}
    if parameters is not None:
        report["validation"] = check_input(parameters, op.input_shape)
    return report
