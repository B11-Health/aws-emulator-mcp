#!/usr/bin/env python3
"""Validate a generated MCPB's actual bundled CLI; no Docker or AWS required."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import zipfile


def verify(bundle: Path) -> dict:
    if not bundle.is_file():
        raise ValueError("Missing MCPB archive")
    with tempfile.TemporaryDirectory(prefix="aws-mcpb-smoke-") as td:
        dest = Path(td)
        with zipfile.ZipFile(bundle) as archive:
            seen = set()
            for info in archive.infolist():
                name = PurePosixPath(info.filename)
                if (info.filename.startswith("/") or ".." in name.parts or
                        info.filename in seen or "\\" in info.filename):
                    raise ValueError("Unsafe archive path")
                seen.add(info.filename)
                if info.is_dir():
                    continue
                if info.file_size > 36 * 1024 * 1024:
                    raise ValueError("Archive contains an oversized file")
                target = dest.joinpath(*name.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(info))
        manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
        pkg = json.loads((dest / "package.json").read_text(encoding="utf-8"))
        if manifest.get("version") != pkg.get("version"):
            raise ValueError("Manifest/node version mismatch")
        script = dest / "bin" / "aws-emulator-mcp.mjs"
        env = dict(os.environ)
        env["DOCKER_HOST"] = "tcp://192.0.2.4:2375"
        result = subprocess.run(["node", str(script), "try", "--json"],
                                cwd=dest, env=env, capture_output=True,
                                text=True, timeout=25)
        if result.returncode:
            raise RuntimeError("Unpacked offline trial failed: " + result.stderr[:350])
        offline = json.loads(result.stdout)
        if (offline.get("passed") is not True or offline.get("artifactCount") != 7
                or offline.get("dockerUsed") is not False
                or offline.get("cloudCallsMade") is not False):
            raise RuntimeError("Unpacked offline trial evidence is inconsistent")
        readiness = subprocess.run(["node", str(script), "preflight", "--json"],
                                   cwd=dest, env=env, capture_output=True,
                                   text=True, timeout=25)
        if readiness.returncode != 1:
            raise RuntimeError("Remote Docker override was not rejected safely")
        state = json.loads(readiness.stdout)
        if state.get("emulatorReady") is not False:
            raise RuntimeError("Preflight claimed remote daemon was ready")
        config = subprocess.run(["node", str(script), "config", "copilot"],
                                cwd=dest, env=env, capture_output=True,
                                text=True, timeout=25)
        if config.returncode:
            raise RuntimeError("Unpacked native Copilot config failed")
        payload = json.loads(config.stdout)
        c = payload["mcpServers"]["aws-emulator-local"]
        if Path(c["args"][0]).resolve() != script.resolve() or c["args"][1] != "mcp":
            raise RuntimeError("Unpacked config pointed to another source")
    summary = {
        "passed": True,
        "file": bundle.name,
        "version": pkg["version"],
        "sha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
        "offlineArtifacts": offline["artifactCount"],
        "dockerUsed": False,
        "cloudCallsMade": False,
        "remoteDockerRejected": True,
        "nativeCopilotConfigValid": True,
        "desktopHostTested": False,
        "scope": "MCPB package and unpacked CLI only; no Claude Desktop tool session",
    }
    return summary


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle", type=Path)
    args = ap.parse_args()
    report = verify(args.bundle)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
