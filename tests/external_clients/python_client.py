"""Independent Python MCP SDK interop, separate from the server implementation.

Dev-only dependency: pip install mcp==2.3.0
"""
import asyncio
import json
from pathlib import Path
import sys

from mcp import Client, StdioServerParameters

SERVER = Path(__file__).resolve().parents[2]/"src"/"aws_emulator_mcp"/"server.py"

async def main():
    results = []
    for mode in ("legacy", "auto"):
        params=StdioServerParameters(command=sys.executable, args=[str(SERVER)])
        async with Client(params, mode=mode) as client:
            tools=await client.list_tools()
            assert len(tools.tools)==27, f"{mode}: expected 27 tools, got {len(tools.tools)}"
            response=await client.call_tool("emulator_status", {})
            assert not response.is_error, f"{mode}: {response.content}"
            status=json.loads(response.content[0].text)
            assert status["endpoint"].startswith("https://127.0.0.1:")
            results.append({
                "mode":mode,"protocol":str(client.protocol_version),
                "tools":len(tools.tools),"local_endpoint":True,
            })
    assert results[0]["protocol"]=="2025-11-25"
    assert results[1]["protocol"]=="2026-07-28"
    print(json.dumps({"client":"official Python MCP SDK v2.3.0",
                      "passed":True,"results":results},indent=2))

if __name__=="__main__":
    asyncio.run(main())
