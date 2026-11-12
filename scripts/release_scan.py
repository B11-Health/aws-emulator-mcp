"""Pre-publication source hygiene checks. Fails on common credential signatures.

This is a defense-in-depth heuristic, not a substitute for GitHub secret
scanning or an independent security review. Scans tracked source files only.
"""
from __future__ import annotations
from pathlib import Path
import re
import ast
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
TEXT_SUFFIXES={".py",".js",".mjs",".ts",".json",".md",".yml",".yaml",".toml",".sh",".ps1",".cmd",".html",".txt"}
KEY_PATTERNS={
    "AWS_ACCESS_KEY":re.compile(r"(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])"),
    "PRIVATE_KEY":re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "GITHUB_TOKEN":re.compile(r"(?<![A-Za-z0-9])(?:ghp_|gho_|ghs_|ghr_)[A-Za-z0-9]{36,}"),
    "GITHUB_FINE_GRAINED_TOKEN":re.compile(r"github_pat_[A-Za-z0-9_]{50,}"),
    "SLACK_BOT_TOKEN":re.compile(r"xoxb-[0-9]{10,}-[A-Za-z0-9-]+"),
}

def git_files()->list[Path]:
    result=subprocess.run(["git","-C",str(ROOT),"ls-files","-z"],
        capture_output=True,check=True)
    return [ROOT/Path(part.decode("utf-8",errors="replace"))
            for part in result.stdout.split(b"\0") if part]

def scan(files:list[Path])->list[dict]:
    issues=[]
    for file in files:
        if file.suffix.lower() not in TEXT_SUFFIXES:continue
        try:text=file.read_text(encoding="utf-8")
        except (OSError,UnicodeError):continue
        for name,pattern in KEY_PATTERNS.items():
            match=pattern.search(text)
            if match:
                issues.append({
                    "file":str(file.relative_to(ROOT)).replace("\\","/"),
                    "rule":name,
                    "offset":match.start(),
                    # Never print credential values.
                })
    return issues

def main()->int:
    issues=scan([p for p in git_files() if p.is_file()])
    config=(ROOT/"pyproject.toml").read_text(encoding="utf-8")
    project=config.split("[project]",1)
    if len(project)!=2:
        print("Missing [project] metadata",file=sys.stderr)
        return 1
    body=project[1].split("\n[",1)[0]
    versions=re.findall(r'(?m)^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$',body)
    if len(versions)!=1:
        print("Missing or ambiguous project version",file=sys.stderr)
        return 1
    version=versions[0]
    source=(ROOT/"src/aws_emulator_mcp/__init__.py").read_text(encoding="utf-8")
    server=(ROOT/"src/aws_emulator_mcp/server.py").read_text(encoding="utf-8")
    def literal_assignment(text,name):
        for node in ast.parse(text).body:
            if isinstance(node,ast.Assign) and any(
                    isinstance(target,ast.Name) and target.id==name
                    for target in node.targets):
                return ast.literal_eval(node.value)
        return None
    consistency=(
        literal_assignment(source,"__version__")==version
        and literal_assignment(server,"VERSION")==version
        and (ROOT/"LICENSE").is_file()
        and (ROOT/"SECURITY.md").is_file()
        and (ROOT/"CONTRIBUTING.md").is_file()
    )
    if issues or not consistency:
        print("Release source scan: FAIL")
        for issue in issues:
            print("Flag:",issue["file"],issue["rule"],"offset",issue["offset"])
        if not consistency:print("Version/package/required documentation mismatch")
        return 1
    print("Release source scan: PASS")
    print("Tracked files checked:",len(git_files()))
    print("Version consistent:",version)
    print("Credential heuristic matches: 0")
    print("Note: independent secret scanning and security review still required.")
    return 0

if __name__=="__main__":
    raise SystemExit(main())
