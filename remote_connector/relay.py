"""Single-agent outbound relay for Windows/WSL MCP diagnostics.

Agent initiates WSS from Windows, gateway never dials into Windows.
Separate from ChatGPT-side OpenAI mTLS. Bearer here is a random local secret,
not an OpenAI API key. No general command/OS execution is possible.
"""
from __future__ import annotations
import asyncio
import hmac
import json
import os
import secrets
from pathlib import Path
from aiohttp import web, WSMsgType

SECRET_FILE=Path(os.environ.get("CODEGYM_RELAY_SECRET_FILE",
    "/opt/codegym-mcp-gateway/private/relay.secret"))
MAX_BYTES=131072
_agent=None
_waiting={}
_send_lock=None

def agent_connected():
    return _agent is not None and not _agent.closed

def _secret():
    return SECRET_FILE.read_text().strip()

async def agent_websocket(request):
    global _agent,_send_lock
    allowed_origin=os.environ.get("CODEGYM_RELAY_ORIGIN","")
    if not allowed_origin or request.headers.get("Origin") not in (None,allowed_origin):
        raise web.HTTPForbidden(text="Invalid relay Origin")
    header=request.headers.get("Authorization","")
    if not hmac.compare_digest(header,"Bearer "+_secret()):
        raise web.HTTPUnauthorized(text="Relay authentication failed")
    if agent_connected():
        raise web.HTTPConflict(text="Only one Windows relay agent is permitted")
    ws=web.WebSocketResponse(heartbeat=18,receive_timeout=75,max_msg_size=MAX_BYTES,
                            autoping=True,compress=False)
    await ws.prepare(request)
    _agent=ws
    _send_lock=asyncio.Lock()
    try:
        async for msg in ws:
            if msg.type!=WSMsgType.TEXT:
                if msg.type in (WSMsgType.CLOSED,WSMsgType.ERROR):break
                continue
            try:
                data=json.loads(msg.data)
            except (json.JSONDecodeError,UnicodeError):
                continue
            if not isinstance(data,dict):continue
            tag=data.get("id")
            if not isinstance(tag,str) or len(tag)>64:continue
            future=_waiting.pop(tag,None)
            if future and not future.done():
                result=data.get("response")
                if not isinstance(result,dict):
                    future.set_exception(ValueError("Invalid response from agent"))
                else:future.set_result(result)
    finally:
        if _agent is ws:_agent=None
        for future in tuple(_waiting.values()):
            if not future.done():future.set_exception(ConnectionError("Windows agent disconnected"))
        _waiting.clear()
    return ws

async def call_windows(rpc):
    if not agent_connected():
        raise web.HTTPServiceUnavailable(text="Local Windows relay is offline")
    tag=secrets.token_hex(12)
    future=asyncio.get_running_loop().create_future()
    _waiting[tag]=future
    try:
        async with _send_lock:
            await _agent.send_json({"id":tag,"rpc":rpc},dumps=lambda x:json.dumps(x,separators=(",",":")))
        return await asyncio.wait_for(future,timeout=24.0)
    except asyncio.TimeoutError as e:
        raise web.HTTPGatewayTimeout(text="Local agent timed out") from e
    except (ConnectionError,ValueError) as e:
        raise web.HTTPBadGateway(text="Local agent unavailable") from e
    finally:
        _waiting.pop(tag,None)
