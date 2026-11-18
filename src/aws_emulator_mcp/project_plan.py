"""Match direct Python SDK calls to reviewable local experiments without importing the app."""
from __future__ import annotations

import ast
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

CONTRACT_DIR = Path(__file__).resolve().parents[2] / "examples" / "contracts"
CONTRACT_FILES = ("s3-write-read.json", "sqs-consume.json", "ec2-vpc.json", "dynamodb-put-get.json")
SERVICE = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
METHOD = re.compile(r"[a-z][a-z0-9-]{0,63}\.[a-z][a-z0-9_]{0,95}\Z")
MAX_SOURCE = 128 * 1024
MAX_METHODS = 80
SCOPE = (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda,
         ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


def _method(step):
    # The bundled operation names use standard Botocore camel-to-snake conversion.
    snake = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", step["operation"]).lower()
    return step["service"] + "." + snake


def plan_for_methods(methods):
    if (not isinstance(methods, list) or len(methods) > MAX_METHODS or
            any(not isinstance(m, str) or not METHOD.fullmatch(m) for m in methods)):
        raise ValueError("Supply up to 80 low-level service.method identifiers, e.g. sqs.send_message")
    requested = set(methods)
    matched = set()
    drafts = []
    for filename in CONTRACT_FILES:
        plan = json.loads((CONTRACT_DIR / filename).read_text(encoding="utf-8"))
        if filename == "sqs-consume.json" and "sqs.get_queue_url" in requested:
            plan["steps"].insert(1, {
                "id": "lookup", "service": "sqs", "operation": "GetQueueUrl",
                "parameters": {"QueueName": {"$fixture": "queue"}},
                "expect": {"assertions": [{"path": "QueueUrl", "equals": {"$ref": "create.QueueUrl"}}]},
            })
        steps = {_method(step) for step in plan["steps"]}
        overlap = steps & requested
        if overlap:
            matched.update(overlap)
            drafts.append({"service": plan["steps"][0]["service"], "matchedMethods": sorted(overlap),
                           "additionalProbeMethods": sorted(steps - requested), "plan": plan})
    return {"schemaVersion": 1, "executed": False, "clientMethods": sorted(requested),
            "unmatchedMethods": sorted(requested - matched), "drafts": drafts,
            "scope": "Synthetic API probes selected by method name. Application arguments, control flow, "
                     "business assertions and runtime coverage require separate tests."}


def _source_calls(source):
    tree = ast.parse(source)
    nodes = list(ast.walk(tree))
    parents = {child: parent for parent in nodes for child in ast.iter_child_nodes(parent)}
    bindings = defaultdict(list)
    scopes = {tree: tree}

    def scope(node):
        if node not in scopes:
            parent = parents[node]
            scopes[node] = parent if isinstance(parent, SCOPE) else scope(parent)
        return scopes[node]

    def bind(node, name, kind=None, value=None):
        bindings[scope(node), name].append((node, kind, value))

    for node in nodes:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            direct = node in getattr(scope(node), "body", ())
            for alias in node.names:
                kind = None
                if direct and isinstance(node, ast.Import) and alias.name == "boto3":
                    kind = "module"
                if (direct and isinstance(node, ast.ImportFrom) and not node.level
                        and node.module == "boto3" and alias.name == "client"):
                    kind = "factory"
                bind(node, alias.asname or alias.name.split(".")[0], kind)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            stmt = parents[node]
            if (isinstance(stmt, (ast.Assign, ast.AnnAssign)) and
                    stmt in getattr(scope(node), "body", ())):
                bind(node, node.id, "assignment", stmt.value)
            else:
                bind(node, node.id)
        elif isinstance(node, ast.arg):
            bind(node, node.arg)
        elif isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            bind(node, node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                bind(node, name)
                bindings[tree, name].append((node, None, None))
        elif isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)) and node.name:
            bind(node, node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            bind(node, node.rest)

    def lookup(name_node):
        if not isinstance(name_node, ast.Name):
            return None, None
        frame = scope(name_node)
        while True:
            # Class/comprehension/closure-specific lookup is outside this first pass.
            if not isinstance(frame, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef)):
                return None, None
            definitions = bindings[frame, name_node.id]
            if bindings[frame, "*"]:
                return None, None
            if definitions:
                if len(definitions) == 1:
                    definition, kind, value = definitions[0]
                    if (definition.lineno, definition.col_offset) < (name_node.lineno, name_node.col_offset):
                        return kind, value
                return None, None
            if frame is tree:
                return None, None
            frame = scope(frame)

    def client_service(factory):
        if not isinstance(factory, ast.Call):
            return None
        func = factory.func
        if isinstance(func, ast.Attribute) and func.attr == "client":
            recognized = lookup(func.value)[0] == "module"
        else:
            recognized = lookup(func)[0] == "factory"
        if not recognized:
            return None
        literal = factory.args[0] if factory.args else next(
            (kw.value for kw in factory.keywords if kw.arg == "service_name"), None)
        if isinstance(literal, ast.Constant) and isinstance(literal.value, str) and SERVICE.fullmatch(literal.value):
            return literal.value
        return None

    calls = []
    for node in nodes:
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        receiver = node.func.value
        if isinstance(receiver, ast.Name):
            kind, value = lookup(receiver)
            if kind != "assignment":
                continue
            receiver = value
        service = client_service(receiver)
        if service and METHOD.fullmatch(service + "." + node.func.attr):
            calls.append({"line": node.lineno, "method": service + "." + node.func.attr,
                          "keywordNames": sorted(k.arg for k in node.keywords if k.arg is not None),
                          "hasUnresolvedArguments": bool(node.args) or any(k.arg is None for k in node.keywords)})
            if len(calls) > 256:
                raise ValueError("Select a smaller module with at most 256 direct SDK calls")
    return sorted(calls, key=lambda item: (item["line"], item["method"]))


def inspect_path(selected):
    if selected.is_symlink():
        raise ValueError("Choose a regular Python module or a Git checkout")
    checkout = selected.is_dir()
    if checkout:
        try:
            git = subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(selected),
                                  "ls-files", "--cached", "--deduplicate", "-z", "--", "*.py"],
                                 capture_output=True, timeout=15, check=True)
        except (OSError, subprocess.SubprocessError):
            raise ValueError("Directory mode needs a Git working tree and Git on PATH") from None
        root = selected.resolve()
        files = [Path(os.fsdecode(p)) for p in git.stdout.split(b"\0") if p]
        if len(files) > 256:
            raise ValueError("Choose a subdirectory with at most 256 tracked Python files")
    else:
        if not selected.is_file() or selected.suffix != ".py":
            raise ValueError("Choose an existing .py module or a Git checkout directory")
        root, files = selected.parent.resolve(), [Path(selected.name)]
    calls, analyzed, skipped = [], [], []
    total_bytes = 0
    for relative in files:
        path = root / relative
        label = relative.as_posix()
        try:
            if path.resolve() != path or not path.is_file():
                raise ValueError("missing, symlink or non-regular file")
            with path.open("rb") as handle:
                raw = handle.read(MAX_SOURCE + 1)
            if len(raw) > MAX_SOURCE:
                raise ValueError("module exceeds 128 KiB")
            total_bytes += len(raw)
            if total_bytes > 4 * 1024 * 1024:
                raise OverflowError("Choose a subdirectory with at most 4 MiB of Python source")
            found = _source_calls(raw.decode("utf-8-sig"))
        except (UnicodeError, SyntaxError, OSError, ValueError, RecursionError) as exc:
            if isinstance(exc, SyntaxError):
                reason = f"invalid Python syntax at line {exc.lineno}"
            elif type(exc) is ValueError:
                reason = str(exc)
            else:
                reason = "module could not be read as UTF-8 Python"
            if not checkout:
                raise ValueError(reason) from None
            skipped.append({"file": label, "reason": reason})
            continue
        analyzed.append({"file": label, "sha256": hashlib.sha256(raw).hexdigest()})
        calls.extend({"file": label, **c} for c in found)
    report = plan_for_methods(sorted({c["method"] for c in calls}))
    for draft in report["drafts"]:
        probe_args = defaultdict(set)
        for step in draft["plan"]["steps"]:
            probe_args[_method(step)].update(step.get("parameters", {}))
        gaps = []
        for call in calls:
            if call["method"] in probe_args:
                missing = sorted(set(call["keywordNames"]) - probe_args[call["method"]])
                if missing or call["hasUnresolvedArguments"]:
                    gaps.append({"file": call["file"], "line": call["line"], "method": call["method"],
                                 "unexercisedKeywords": missing, "unresolvedArguments": call["hasUnresolvedArguments"]})
        draft["argumentGaps"] = gaps
    report.update(calls=calls, analyzedFiles=analyzed, skippedFiles=skipped,
                  discoveryScope="Direct method calls on uniquely bound, literal-service boto3.client instances. "
                                 "Dynamic factories, injected clients, resources and wrappers may be missed.")
    return report


def main(args):
    try:
        if sys.version_info < (3, 10):
            raise ValueError("project-plan requires Python 3.10 or newer")
        selected, *args = args
        report = inspect_path(Path(selected))
        if args[:1] == ["--contract"] and len(args) == 2:
            if report["skippedFiles"]:
                print(f"Skipped {len(report['skippedFiles'])} source file(s). See --json for details.", file=sys.stderr)
            draft = next((d for d in report["drafts"] if d["service"] == args[1]), None)
            if draft is None:
                raise ValueError("No matching contract for that service in this module")
            print(json.dumps(draft["plan"], indent=2))
        elif args == ["--json"]:
            print(json.dumps(report, indent=2))
        elif not args:
            for call in report["calls"]:
                print(f"{call['file']}:{call['line']}  {call['method']}")
            if not report["calls"]:
                print("No direct boto3 client calls recognized in the selected source.")
            for draft in report["drafts"]:
                print(f"Draft {draft['service']}: {draft['plan']['name']} ({len(draft['plan']['steps'])} steps)")
                for gap in draft["argumentGaps"]:
                    missing = ", ".join(gap["unexercisedKeywords"])
                    if gap["unresolvedArguments"]:
                        missing = (missing + ", " if missing else "") + "dynamic or positional arguments"
                    print(f"  Review {gap['file']}:{gap['line']} {gap['method']}: {missing}")
            if report["unmatchedMethods"]:
                print("Without a bundled test:", ", ".join(report["unmatchedMethods"]))
            for skipped in report["skippedFiles"]:
                print(f"Skipped {skipped['file']}: {skipped['reason']}")
            print(report["scope"])
            print(report["discoveryScope"])
        else:
            raise ValueError("Use --json or --contract SERVICE")
    except (ValueError, OSError, RecursionError, OverflowError) as exc:
        if isinstance(exc, UnicodeError):
            print("Select a UTF-8 Python module", file=sys.stderr)
        elif isinstance(exc, OSError):
            print("Could not load the bundled contracts", file=sys.stderr)
        else:
            print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
