#!/usr/bin/env python3
"""Generate ready-to-copy client configurations without altering client settings."""
import argparse
import json
from pathlib import Path

def render(root,target):
    root=Path(root).resolve()
    launcher=root/"scripts"/"serve_wsl.sh"
    if not launcher.is_file():
        raise ValueError("Missing bundled MCP launcher: "+str(launcher))
    if target=="windows-wsl":
        if "\\" in str(launcher) or ":" in str(launcher):
            raise ValueError("For a Windows/WSL config, run generator inside WSL and pass its /mnt/... path")
        launch={"command":"wsl.exe","args":["-e","bash",str(launcher)]}
    elif target=="linux":
        launch={"command":"bash","args":[str(launcher)]}
    else:
        raise ValueError("Unsupported target")
    return {
        "mcp": {"mcpServers":{"aws-emulator-local":launch}},
        # The native Copilot harness uses mcpServers, not the legacy VS Code
        # editor-managed servers format. VS Code is deprecating the latter.
        "copilot": {"mcpServers":{"aws-emulator-local":{
            "type":"stdio","command":launch["command"],"args":launch["args"]}}},
        "vscode": {"servers":{"aws-emulator-local":{
            "type":"stdio","command":launch["command"],"args":launch["args"]}}}
    }

def main():
    p=argparse.ArgumentParser()
    p.add_argument("root",help="Absolute path as seen from WSL/Linux")
    p.add_argument("--target",choices=["windows-wsl","linux"],required=True)
    p.add_argument("--out",help="Output directory; defaults to repo/generated")
    args=p.parse_args()
    directory=Path(args.out) if args.out else Path(args.root)/"generated"
    directory.mkdir(parents=True,exist_ok=True)
    payloads=render(args.root,args.target)
    names={"mcp":"mcp-client."+args.target+".json",
           "copilot":"copilot-mcp."+args.target+".json",
           "vscode":"vscode-mcp."+args.target+".json"}
    for name,content in payloads.items():
        target=directory/names[name]
        target.write_text(json.dumps(content,indent=2)+"\n",encoding="utf-8")
        print("MCP config:",target)
    return 0

if __name__=="__main__":raise SystemExit(main())
