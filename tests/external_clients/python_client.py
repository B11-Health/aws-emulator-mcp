"""Independent Python MCP SDK interop, separate from the server implementation.

Dev-only dependency: pip install mcp==2.3.0
"""
import asyncio
import json
from pathlib import Path
import sys
import threading
from mcp import Client, StdioServerParameters
from mcp.client.streamable_http import streamable_http_client
import httpx2

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"src"))
from aws_emulator_mcp.http_transport import create_server

SERVER = ROOT/"src"/"aws_emulator_mcp"/"server.py"

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
    # Exercise the actual authenticated Streamable HTTP listener as well.
    token="codegym-temporary-sdk-test-"+("x"*48)
    server=create_server(port=0,token=token)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    http_results=[]
    try:
        url=f"http://127.0.0.1:{server.server_port}/mcp"
        for mode in ("legacy","auto"):
            async with httpx2.AsyncClient(
                headers={"Authorization":"Bearer "+token},
                timeout=httpx2.Timeout(20.0,read=40.0),
            ) as http:
                async with Client(streamable_http_client(url,http_client=http),mode=mode) as client:
                    found=await client.list_tools()
                    status=await client.call_tool("emulator_status",{})
                    parsed=json.loads(status.content[0].text)
                    assert not status.is_error and len(found.tools)==27
                    assert parsed["endpoint"].startswith("https://127.0.0.1:")
                    http_results.append({"mode":mode,"protocol":str(client.protocol_version),
                                         "tools":len(found.tools),"authenticated":True})
        assert http_results[0]["protocol"]=="2025-11-25"
        assert http_results[1]["protocol"]=="2026-07-28"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
    print(json.dumps({"client":"official Python MCP SDK v2.3.0",
                      "passed":True,"stdio":results,"authenticated_http":http_results},indent=2))

if __name__=="__main__":
    asyncio.run(main())
