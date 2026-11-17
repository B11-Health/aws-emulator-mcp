#!/usr/bin/env python3
"""Build and verify a Claude Desktop MCPB from this repo's npm allowlist.

Requires maintainer Python 3.10+, npm, and access to the pinned official
@anthropic-ai/mcpb CLI. Does not install a desktop extension or modify client
settings. This bundles source/config only, never the large emulator binary.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "packaging" / "claude-desktop" / "manifest.json"
MCPB_CLI = "@anthropic-ai/mcpb@2.1.2"
MAX_SOURCE_BYTES = 36 * 1024 * 1024


def executable(name: str) -> str:
    lookup = (name + ".cmd") if os.name == "nt" else name
    value = shutil.which(lookup)
    if not value:
        raise RuntimeError(f"Missing {lookup}; install Node/npm tooling")
    return value


def invoke(command: list[str], *, cwd: Path, seconds: int = 120) -> str:
    res = subprocess.run(command, cwd=cwd, capture_output=True, text=True,
                         timeout=seconds, check=False)
    if res.returncode:
        raise RuntimeError(f"Build tool failed (exit {res.returncode}): "
                           + (res.stderr or res.stdout)[-1000:])
    return res.stdout


def unpack_npm(tgz: Path, stage: Path) -> None:
    total = 0
    with tarfile.open(tgz, "r:gz") as archive:
        for entry in archive:
            pure = PurePosixPath(entry.name)
            if not pure.parts or pure.parts[0] != "package" or ".." in pure.parts:
                raise RuntimeError("Unexpected npm archive path")
            if entry.isdir():
                continue
            if not entry.isfile() or len(pure.parts) < 2:
                raise RuntimeError("Unexpected npm archive entry")
            rel = Path(*pure.parts[1:])
            dest = stage / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            content = archive.extractfile(entry)
            if content is None or entry.size < 0 or entry.size > MAX_SOURCE_BYTES:
                raise RuntimeError("Unsafe npm archive member")
            total += entry.size
            if total > MAX_SOURCE_BYTES:
                raise RuntimeError("Unexpectedly large npm source package")
            dest.write_bytes(content.read())
    required = [
        "bin/aws-emulator-mcp.mjs", "docker/Dockerfile",
        "docker/entrypoint.sh", "scripts/image_identity.mjs",
        "scripts/preflight.mjs", "scripts/offline_trial.mjs",
        "src/aws_emulator_mcp/server.py", "scripts/install_wsl.sh",
        "examples/order-intake/buggy/order_service.py",
        "examples/reliability-lab/recovery/order_service.py",
    ]
    for name in required:
        if not (stage / name).is_file():
            raise RuntimeError("Missing packaged runtime input: " + name)


def inspect_bundle(bundle: Path, manifest: dict, npm_version: str) -> dict:
    with zipfile.ZipFile(bundle) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise RuntimeError("Duplicate MCPB ZIP entries")
        if any(n.startswith("/") or ".." in PurePosixPath(n).parts
               for n in names):
            raise RuntimeError("Unsafe MCPB ZIP path")
        for key in ("manifest.json", "bin/aws-emulator-mcp.mjs",
                    "scripts/image_identity.mjs", "docker/Dockerfile"):
            if key not in names:
                raise RuntimeError("Missing MCPB file: " + key)
        inside = json.loads(archive.read("manifest.json"))
        pkg = json.loads(archive.read("package.json"))
        if inside != manifest or pkg.get("version") != npm_version:
            raise RuntimeError("Manifest/package mismatch")
        if any(n.endswith(".env") or n.startswith(".git/")
               or "/node_modules/" in n for n in names):
            raise RuntimeError("Unsafe private or development bundle content")
    size = bundle.stat().st_size
    if not 10000 < size < MAX_SOURCE_BYTES:
        raise RuntimeError("Unexpected MCPB size")
    return {
        "version": npm_version, "sha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
        "bytes": size, "fileCount": len(names), "unsigned": True,
        "scope": "Local Claude Desktop developer-preview bundle; Docker required for MCP tools."
    }


def build(output: Path) -> dict:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    npm_version = json.loads((ROOT / "package.json").read_text())["version"]
    if manifest["version"] != npm_version:
        raise RuntimeError("MCPB manifest version differs from Node package")
    if manifest["server"]["mcp_config"]["args"] != [
            "$" + "{__dirname}/bin/aws-emulator-mcp.mjs", "mcp"]:
        raise RuntimeError("MCPB launch must use its own bundled CLI")
    output = output.expanduser().resolve()
    if output.exists():
        raise RuntimeError("Refusing to overwrite an existing extension")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="aws-mcpb-") as td:
        temp = Path(td)
        stage = temp / "extension"
        stage.mkdir()
        filename = f"aws-emulator-mcp-{npm_version}.tgz"
        produced = invoke([executable("npm"), "pack", "--silent",
                           "--pack-destination", str(temp)], cwd=ROOT, seconds=110).strip()
        if filename not in produced or not (temp / filename).is_file():
            raise RuntimeError("npm pack did not produce expected pinned artifact")
        unpack_npm(temp / filename, stage)
        (stage / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8"
        )
        npm = executable("npx")
        prefix = [npm, "--yes", MCPB_CLI]
        invoke(prefix + ["validate", str(stage)], cwd=ROOT, seconds=110)
        invoke(prefix + ["pack", str(stage), str(output)], cwd=ROOT, seconds=110)
    result = inspect_bundle(output, manifest, npm_version)
    print(json.dumps({"file": str(output), **result}, indent=2))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Build validated MCPB; no client changes")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
