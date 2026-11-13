"""Safely add one generated AWS Emulator MCP server entry to a client config.

No implicit writes: --apply is mandatory for mutation. Existing unrelated
servers are preserved, and any changed file gets a timestamped backup.
This is deliberately strict JSON; JSONC must be managed by the client UI.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

NAME = "aws-emulator-local"
MAX_CONFIG_BYTES = 2_000_000


class ConfigError(ValueError):
    pass


def read_object(path: Path) -> dict:
    if path.stat().st_size > MAX_CONFIG_BYTES:
        raise ConfigError("Configuration exceeds 2 MB; refusing to modify")
    def no_duplicates(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                raise ConfigError("Duplicate JSON property; refusing to modify")
            out[key] = value
        return out
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"),
                          object_pairs_hook=no_duplicates)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ConfigError("Configuration is not strict JSON; use client UI instead") from exc
    if not isinstance(data, dict):
        raise ConfigError("Configuration must be a JSON object")
    return data


def extract_source(source: Path, field: str) -> dict:
    data = read_object(source)
    servers = data.get(field)
    if not isinstance(servers, dict) or set(servers) != {NAME}:
        raise ConfigError("Expected exactly one generated aws-emulator-local entry")
    candidate = servers[NAME]
    if not isinstance(candidate, dict):
        raise ConfigError("Generated server must be an object")
    command = candidate.get("command")
    args = candidate.get("args")
    if not (command in ("bash", "wsl.exe") and isinstance(args, list)
            and all(isinstance(arg, str) for arg in args)
            and len(args) in (1, 3)):
        raise ConfigError("Generated launcher has an unexpected command")
    if command == "wsl.exe":
        if args[:2] != ["-e", "bash"] or len(args) != 3:
            raise ConfigError("Unsafe Windows/WSL command arguments")
        launcher = args[2]
    else:
        if len(args) != 1:
            raise ConfigError("Unsafe Linux command arguments")
        launcher = args[0]
    if not (launcher.startswith("/") and launcher.endswith("/scripts/serve_wsl.sh")):
        raise ConfigError("Launcher must be an absolute bundled local path")
    if set(candidate) - {"command", "args", "type"}:
        raise ConfigError("Unexpected keys in generated launcher")
    if candidate.get("type", "stdio") != "stdio":
        raise ConfigError("Only stdio MCP launchers are supported")
    return candidate


def merge(source: Path, destination: Path, field="mcpServers",
          apply=False, replace_existing=False) -> dict:
    source = source.expanduser().absolute()
    destination = destination.expanduser().absolute()
    if source == destination:
        raise ConfigError("Source and destination must be different")
    if not source.is_file() or source.is_symlink():
        raise ConfigError("Generated source file missing or linked")
    candidate = extract_source(source, field)
    if destination.is_symlink():
        raise ConfigError("Refusing to overwrite a symlink")
    if destination.exists() and not destination.is_file():
        raise ConfigError("Destination is not a regular file")
    data = read_object(destination) if destination.exists() else {}
    servers = data.get(field, {})
    if not isinstance(servers, dict):
        raise ConfigError("Existing server collection is not an object")
    present = servers.get(NAME)
    if present == candidate:
        return {"status":"already_configured","changed":False,
                "destination":str(destination)}
    if present is not None and not replace_existing:
        raise ConfigError("Conflicting aws-emulator-local entry; review manually or pass --replace")
    action = "replace_existing" if present is not None else "add_server"
    if not apply:
        return {"status":"preview","action":action,"changed":False,
                "destination":str(destination),"will_backup":destination.exists()}
    # Do not silently alter other server entries.
    servers[NAME] = candidate
    data[field] = servers
    payload = json.dumps(data,indent=2,ensure_ascii=False,allow_nan=False)+"\n"
    parent = destination.parent
    parent.mkdir(parents=True,exist_ok=True)
    # Atomic file replacement where the underlying filesystem permits it.
    file_path = None
    backup = None
    try:
        with tempfile.NamedTemporaryFile(mode="w",encoding="utf-8",newline="\n",
                prefix="."+destination.name+".",suffix=".tmp",dir=parent,
                delete=False) as f:
            file_path = Path(f.name)
            f.write(payload)
        try:
            os.chmod(file_path,0o600)
        except OSError:
            pass
        if destination.exists():
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = destination.with_name(destination.name+".bak."+stamp)
            if backup.exists():
                raise ConfigError("Backup already exists; refusing to overwrite")
            shutil.copy2(destination,backup)
            try:
                os.chmod(backup,0o600)
            except OSError:
                pass
        os.replace(file_path,destination)
    finally:
        if file_path and file_path.exists():
            file_path.unlink()
    return {"status":"updated","action":action,"changed":True,
            "destination":str(destination),
            "backup":str(backup) if backup else None}


def main() -> int:
    p = argparse.ArgumentParser(description="Opt-in, backup-first MCP client config merge")
    p.add_argument("--source",type=Path,required=True)
    p.add_argument("--destination",type=Path,required=True)
    p.add_argument("--field",choices=("mcpServers","servers"),default="mcpServers")
    p.add_argument("--apply",action="store_true",help="Allow writing client config")
    p.add_argument("--replace",action="store_true",help="Replace a conflicting named entry")
    args=p.parse_args()
    try:
        result=merge(args.source,args.destination,args.field,args.apply,args.replace)
    except (ConfigError,OSError) as exc:
        print("Client config refused: "+str(exc),file=sys.stderr)
        return 2
    print(json.dumps(result,indent=2))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
