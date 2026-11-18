"""Read-only AST onboarding for selected trusted Python app-case modules.

This module intentionally uses only the Python standard library. It never
imports, compiles or executes application source; it cannot prove runtime
coverage and its starter case must be reviewed before execution.
"""
from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
import re
import sys

MAX_SOURCE = 20 * 1024
MAX_CASE = 48 * 1024
IDENT = re.compile(r"[A-Za-z_][A-Za-z_0-9]{0,63}\Z")
SERVICE = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
METHOD = re.compile(r"[a-z][a-z0-9_]{0,95}\Z")


class SelectionError(ValueError):
    pass


def _read(filename: str, suffix: str, limit: int) -> bytes:
    if not isinstance(filename, str) or len(filename) > 260 or filename.startswith('-') or \
            filename.lower().startswith(('https:', 'http:', 'file:')):
        raise SelectionError("Choose a local, bounded, regular file, not a URL or option")
    file = Path(filename)
    try:
        if file.is_symlink() or not file.is_file() or file.suffix != suffix:
            raise SelectionError("Choose a regular .py or .json file, no symlinks")
        size = file.stat().st_size
        if size < 1 or size > limit:
            raise SelectionError("File exceeds the allowed size")
        contents = file.read_bytes()
        if not 1 <= len(contents) <= limit:
            raise SelectionError("File changed during inspection")
        return contents
    except OSError:
        raise SelectionError("Selected local file cannot be read") from None


def _call_name(node: ast.AST) -> str | None:
    if not isinstance(node, ast.Attribute) or not METHOD.fullmatch(node.attr):
        return None
    base = node.value
    if not isinstance(base, ast.Subscript) or not isinstance(base.value, ast.Name) or \
            base.value.id != 'clients' or not isinstance(base.slice, ast.Constant) or \
            not isinstance(base.slice.value, str) or not SERVICE.fullmatch(base.slice.value):
        return None
    return base.slice.value + '.' + node.attr


def _operation(method: str) -> str:
    # SDK method syntax is a *candidate* mapping, not a verified Botocore model.
    return ''.join(part.capitalize() for part in method.split('_'))


def _all_current_nodes(fn: ast.FunctionDef):
    queue = list(fn.body)
    while queue:
        node = queue.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        yield node
        queue.extend(ast.iter_child_nodes(node))


def _literal_key(node: ast.AST, base_name: str) -> str | None:
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and \
            node.value.id == base_name and isinstance(node.slice, ast.Constant) and \
            isinstance(node.slice.value, str) and IDENT.fullmatch(node.slice.value):
        return node.slice.value
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and \
            isinstance(node.func.value, ast.Name) and node.func.value.id == base_name and \
            node.func.attr == 'get' and len(node.args) >= 1 and \
            isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str) and \
            IDENT.fullmatch(node.args[0].value):
        return node.args[0].value
    return None


def _eligible(fn: ast.FunctionDef) -> bool:
    args = fn.args
    return (not args.posonlyargs and not args.vararg and not args.kwarg and
            not args.kwonlyargs and len(args.args) == 2 and
            [a.arg for a in args.args] == ['clients', 'inputs'])


def inspect_source(raw: bytes, entrypoint: str = 'handle') -> dict:
    if not isinstance(entrypoint, str) or not IDENT.fullmatch(entrypoint) or entrypoint.startswith('_'):
        raise SelectionError('Entrypoint must be a public Python identifier')
    try:
        source = raw.decode('utf-8')
        if '\0' in source:
            raise SelectionError('Python file contains NUL bytes')
        parsed = ast.parse(source)
    except UnicodeError:
        raise SelectionError('Selected Python file is not valid UTF-8') from None
    except SyntaxError as exc:
        raise SelectionError(f'Selected Python file has invalid syntax on line {exc.lineno}') from None
    found = [fn for fn in parsed.body if isinstance(fn, ast.FunctionDef) and fn.name == entrypoint]
    match = found[0] if len(found) == 1 else None
    shape_valid = bool(match and _eligible(match))
    calls = []
    input_keys = set()
    unresolved = []
    if match:
        inspected = list(_all_current_nodes(match))
        parents = {child: parent for parent in inspected for child in ast.iter_child_nodes(parent)}
        for node in inspected:
            if isinstance(node, ast.Call):
                method = _call_name(node.func)
                if method:
                    service, snake = method.split('.', 1)
                    calls.append({'line': node.lineno, 'service': service, 'method': snake,
                                  'operationCandidate': _operation(snake)})
                elif isinstance(node.func, ast.Attribute) and (
                        isinstance(node.func.value, ast.Name) and node.func.value.id == 'clients' or
                        isinstance(node.func.value, ast.Subscript) and
                        isinstance(node.func.value.value, ast.Name) and
                        node.func.value.value.id == 'clients'):
                    unresolved.append({'line': node.lineno, 'reason': 'dynamic_or_unsupported_client_access'})
            key = _literal_key(node, 'inputs')
            if key:
                input_keys.add(key)
            if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and \
                    node.value.id == 'clients':
                # Detect aliases, SDK method references not called, and dynamic
                # selectors. Never silently count client aliases as covered.
                parent = parents.get(node)
                grandparent = parents.get(parent)
                direct_call = (isinstance(parent, ast.Attribute) and parent.value is node and
                               isinstance(grandparent, ast.Call) and grandparent.func is parent and
                               _call_name(parent) is not None)
                if not direct_call:
                    valid_service = (isinstance(node.slice, ast.Constant) and
                                     isinstance(node.slice.value, str) and
                                     SERVICE.fullmatch(node.slice.value))
                    unresolved.append({'line': node.lineno, 'reason':
                        'client_reference_not_direct_call' if valid_service else
                        'dynamic_service_identifier'})
            if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and \
                    node.value.id == 'inputs' and _literal_key(node, 'inputs') is None:
                unresolved.append({'line': node.lineno, 'reason': 'dynamic_or_nonstandard_input_key'})
    calls.sort(key=lambda c: (c['line'], c['service'], c['method']))
    unresolved = sorted({(c['line'], c['reason']) for c in unresolved})
    unique = sorted({(c['service'], c['operationCandidate']) for c in calls})
    suggested = []
    methods = {f"{call['service']}.{call['method']}" for call in calls}
    if {'dynamodb.put_item', 'sqs.send_message'}.issubset(methods):
        suggested.append('examples/app-case/sqs-idempotency.json')
    if 's3.put_object' in methods:
        suggested.append('examples/app-case/s3-object-write.json')
    starter = None
    if match and shape_valid and unique and len({s for s, _ in unique}) <= 4 and len(unique) <= 8:
        starter = {'schemaVersion': 1, 'name': 'review-required-app-case',
                   'services': sorted({s for s, _ in unique}), 'setup': [],
                   'invoke': {'entrypoint': entrypoint, 'times': 1,
                              'inputs': {key: 'REPLACE_WITH_SYNTHETIC_VALUE' for key in sorted(input_keys)},
                              'expectedCalls': [{'service': s, 'operation': op,
                                                 'min': 1, 'max': 1} for s, op in unique]},
                   'checks': [], 'cleanup': [],
                   'regression': {'stepId': 'REVIEW_ME', 'path': 'REVIEW_ME'},
                   'reviewRequired': True}
    return {'schemaVersion': 1, 'mode': 'static_app_case_inspection',
            'sourceSha256': hashlib.sha256(raw).hexdigest(),
            'entrypoint': entrypoint, 'entrypointFound': match is not None,
            'entrypointSignatureMatches': shape_valid,
            'calls': calls, 'inputKeys': sorted(input_keys),
            'unresolvedAccesses': [{'line': l, 'reason': reason} for l, reason in unresolved],
            'starterCase': starter, 'suggestedExamples': suggested,
            'executedSource': False, 'executedAWSCalls': False,
            'caseReadyToRun': False, 'requiresHumanReview': True,
            'scope': 'Literal clients[service].sdk_method calls inside one top-level function only; '
                     'aliases, dynamic services, nested functions, control-flow reachability and SDK model '
                     'support are NOT verified. This is not a runnable test or application validation.'}


def _bad_constant(_):
    raise SelectionError('Non-JSON numeric constant in case')


def _parse_case(raw: bytes) -> dict:
    try:
        case = json.loads(raw.decode('utf-8'), parse_constant=_bad_constant)
    except (UnicodeError, json.JSONDecodeError):
        raise SelectionError('Case must be valid UTF-8 JSON') from None
    if not isinstance(case, dict):
        raise SelectionError('Case must be a JSON object')
    return case


def review_case(report: dict, raw: bytes) -> dict:
    case = _parse_case(raw)
    invoke = case.get('invoke')
    expected = invoke.get('expectedCalls') if isinstance(invoke, dict) else None
    selected_services = case.get('services')
    if not isinstance(expected, list) or not isinstance(selected_services, list):
        raise SelectionError('Case needs invoke.expectedCalls and services for advisory review')
    counters = set()
    for item in expected:
        if not isinstance(item, dict) or not all(isinstance(item.get(k), str) for k in ('service', 'operation')):
            raise SelectionError('Case has invalid SDK call-counter entries')
        counters.add((item['service'], item['operation']))
    syntax = {(c['service'], c['operationCandidate']) for c in report['calls']}
    inputs = invoke.get('inputs', {}) if isinstance(invoke, dict) else {}
    provided = set(inputs) if isinstance(inputs, dict) else set()
    report['caseReview'] = {
        'caseSha256': hashlib.sha256(raw).hexdigest(),
        'entrypointMatches': invoke.get('entrypoint') == report['entrypoint'],
        'missingInputKeys': sorted(set(report['inputKeys']) - provided),
        'callsWithoutExpectedCounters': [{'service': s, 'operationCandidate': op}
                                         for s, op in sorted(syntax-counters)],
        'expectedCountersNotSeenInSyntax': [{'service': s, 'operation': op}
                                            for s, op in sorted(counters-syntax)],
        'discoveredServicesNotDeclared': sorted({s for s, _ in syntax} - set(
            x for x in selected_services if isinstance(x, str))),
        'formalSchemaValidated': False,
        'note': 'Advisory static cross-check only. Callers must review the case and '
                'run the explicit local app-case command for actual assertions.'}
    return report


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    wants_json = '--json' in args
    args = [arg for arg in args if arg != '--json']
    selected_name = None
    if '--entrypoint' in args:
        index = args.index('--entrypoint')
        if index + 1 >= len(args):
            print('Missing --entrypoint value', file=sys.stderr)
            return 2
        selected_name = args[index + 1]
        args = args[:index] + args[index + 2:]
    if not 1 <= len(args) <= 2:
        print('Usage: app-case-inspect FILE.py [CASE.json] [--entrypoint NAME] [--json]', file=sys.stderr)
        return 2
    try:
        source = _read(args[0], '.py', MAX_SOURCE)
        case_raw = _read(args[1], '.json', MAX_CASE) if len(args) == 2 else None
        # When a case is supplied, inspect its selected function rather than
        # assuming every developer names their entrypoint `handle`.
        if selected_name is None and case_raw is not None:
            case = _parse_case(case_raw)
            invoke = case.get('invoke')
            if isinstance(invoke, dict) and isinstance(invoke.get('entrypoint'), str):
                selected_name = invoke['entrypoint']
        report = inspect_source(source, selected_name or 'handle')
        if case_raw is not None:
            review_case(report, case_raw)
    except (SelectionError, RecursionError, MemoryError) as exc:
        print('App case inspection: ' + (str(exc) if isinstance(exc, SelectionError)
                                         else 'Selected module is too complex to inspect safely'), file=sys.stderr)
        return 2
    if wants_json:
        print(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
    else:
        print('AWS Emulator MCP / static application inspection (NO SOURCE EXECUTION)')
        print('  Entrypoint: ' + report['entrypoint'] + (' (supported)' if report['entrypointSignatureMatches'] else ' (not supported)'))
        print('  Source SHA-256: ' + report['sourceSha256'])
        print('  Literal SDK calls: ' + str(len(report['calls'])))
        for call in report['calls']:
            print(f"    line {call['line']}: {call['service']}.{call['method']} (candidate {call['operationCandidate']})")
        print('  Input keys: ' + (', '.join(report['inputKeys']) or 'not recognized'))
        if report.get('caseReview'):
            print('  Case cross-check: review JSON output for gaps before a local run')
        for example in report['suggestedExamples']:
            print('  Related sample: ' + example)
        print('  NEXT: author and review setup, independent assertions, cleanup and regression; '
              'then explicitly run app-case. This inspection is NOT a passing app test.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
