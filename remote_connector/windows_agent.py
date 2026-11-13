"""Code Gym Windows/WSL outbound diagnostic relay for ChatGPT.

Never listens for incoming connections. Reconnects to the secure EC2 broker over
TLS, authenticates with a 384-bit local relay credential. Only these three MCP
read-only tools are accepted; no shell execution, resource mutation, or secrets.
"""
from __future__ import annotations
import asyncio
import json
import os
import random
import sys
from pathlib import Path

import websockets

ROOT=Path(os.environ.get("CODEGYM_MCP_WINDOWS_SOURCE",
    str(Path(__file__).resolve().parents[1]))).resolve()
sys.path.insert(0,str(ROOT/"src"))
from aws_emulator_mcp import server as m

ADDRESS=os.environ.get("CODEGYM_RELAY_URL","")
SECRET=Path(os.environ.get("CODEGYM_RELAY_SECRET_FILE",
    str(Path.home()/".config/codegym-mcp-bridge/relay.secret")))
ALLOWED=frozenset({"emulator_doctor","emulator_status","emulator_identity"})
MAX_WIRE=128*1024

async def process(data):
    if not isinstance(data,dict):
        return None
    tag=data.get("id")
    rpc=data.get("rpc")
    if not isinstance(tag,str) or not (1<=len(tag)<=64):
        return None
    if not isinstance(rpc,dict):
        return {"id":tag,"response":m._rpc_error(None,-32600,"Invalid request")}
    name=rpc.get("params",{}).get("name") if isinstance(rpc.get("params"),dict) else None
    if rpc.get("method")!="tools/call" or name not in ALLOWED:
        answer=m._rpc_error(rpc.get("id"),-32601,"Read-only diagnostic tool unavailable")
    else:
        answer=await asyncio.wait_for(asyncio.to_thread(m.handle,rpc),timeout=22)
    if not isinstance(answer,dict):
        answer=m._rpc_error(rpc.get("id"),-32603,"Empty local result")
    return {"id":tag,"response":answer}

async def serve():
    if not ADDRESS.startswith("wss://") or not ADDRESS.endswith("/agent"):
        raise RuntimeError("CODEGYM_RELAY_URL must use WSS and end in /agent")
    retry=2
    while True:
        try:
            secret=SECRET.read_text(encoding="utf-8").strip()
            if len(secret)<50:raise RuntimeError("Invalid relay credential")
            async with websockets.connect(
                ADDRESS,
                additional_headers={"Authorization":"Bearer "+secret},
                open_timeout=12,close_timeout=5,
                ping_interval=20,ping_timeout=15,
                max_size=MAX_WIRE,compression=None,
            ) as ws:
                print("relay connected (outbound HTTPS; Windows MCP sandbox)",flush=True)
                retry=2
                async for wire in ws:
                    if not isinstance(wire,str):continue
                    try:data=json.loads(wire)
                    except json.JSONDecodeError:continue
                    try:answer=await process(data)
                    except (ValueError,RuntimeError,asyncio.TimeoutError):
                        tag=data.get("id") if isinstance(data,dict) else None
                        answer={"id":tag,"response":m._rpc_error(None,-32603,"Local diagnostic failed")}
                    if answer is not None:
                        await ws.send(json.dumps(answer,separators=(",",":"),ensure_ascii=False))
        except (OSError,websockets.exceptions.WebSocketException,RuntimeError) as error:
            print("relay retry: "+type(error).__name__,flush=True)
        await asyncio.sleep(retry+random.random())
        retry=min(30,retry*1.5)

if __name__=="__main__":
    asyncio.run(serve())
