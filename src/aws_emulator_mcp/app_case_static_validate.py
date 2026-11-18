"""Formal declarative case validation with no developer source execution.

Used only by the local app-guide CLI. No AWS Emulator service is started,
no network connections are made, and no user-selected Python module is loaded.
The validator imports only the project's own existing case-schema validators.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

# -I deliberately ignores PYTHONPATH. Load our audited package sources only.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aws_emulator_mcp import app_case  # noqa: E402
from aws_emulator_mcp.app_case_inspect import _read, _parse_case, MAX_CASE  # noqa: E402


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        return 2
    try:
        raw = _read(args[0], '.json', MAX_CASE)
        case = _parse_case(raw)
        # Exactly the schema checked by the isolated app-case runner.
        app_case.validate_case(case)
        valid = True
    except Exception:
        # Do not leak user-selected paths, sensitive case inputs or exceptions.
        raw = None
        valid = False
    output = {
        'schemaVersion': 1,
        'mode': 'offline_app_case_schema_validation',
        'valid': valid,
        'caseSha256': hashlib.sha256(raw).hexdigest() if raw else None,
        'developerSourceExecuted': False,
        'awsApiCallsMade': False,
        'dockerStarted': False,
        'note': 'Validates the declarative case schema only, not AWS operation-model support, actual service behavior or source safety.'
    }
    print(json.dumps(output, separators=(',', ':'), allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
