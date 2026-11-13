"""MCP staging gateway: narrow, no-write tool visibility on isolated emulator.

HTTPS and OpenAI client-certificate verification are enforced by nginx.
Never broaden ALLOWED_TOOLS without adding per-user OAuth 2.1.
"""
from __future__ import annotations
import asyncio
import hmac
import json
import os
import sys
from aiohttp import web
import relay
from urllib.parse import unquote
from pathlib import Path
from cryptography import x509
from cryptography.x509.oid import ExtendedKeyUsageOID

SOURCE = os.environ.get("CODEGYM_MCP_SOURCE", "").strip()
if not SOURCE:
    raise RuntimeError("Set CODEGYM_MCP_SOURCE to the adapter's src directory")
sys.path.insert(0, SOURCE)
from aws_emulator_mcp import server as m

ALLOWED_TOOLS = frozenset({"emulator_status", "emulator_doctor", "emulator_identity"})
MAX_BYTES = 128 * 1024

def validate(request, msg):
    if request.headers.get("Origin") not in (None, "https://chatgpt.com"):
        raise web.HTTPForbidden(text="Origin not allowed")
    if request.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
        raise web.HTTPUnsupportedMediaType(text="MCP requires application/json")
    accepted = request.headers.get("Accept", "")
    if "application/json" not in accepted or "text/event-stream" not in accepted:
        raise web.HTTPNotAcceptable(text="MCP Accept requires JSON and SSE")
    if not isinstance(msg, dict):
        raise web.HTTPBadRequest(text="Invalid MCP message")
    method = msg.get("method")
    params = msg.get("params")
    meta = params.get("_meta") if isinstance(params, dict) else None
    version = meta.get(m.META_VERSION) if isinstance(meta, dict) else None
    header_version = request.headers.get("MCP-Protocol-Version")
    if version == "2026-07-28":
        if header_version != version:
            raise web.HTTPBadRequest(text="MCP version header mismatch")
        if request.headers.get("Mcp-Method") != method:
            raise web.HTTPBadRequest(text="Mcp-Method mismatch")
        if method == "tools/call" and request.headers.get("Mcp-Name") != params.get("name"):
            raise web.HTTPBadRequest(text="Mcp-Name mismatch")
    elif header_version and version and header_version != version:
        raise web.HTTPBadRequest(text="MCP protocol version mismatch")
    if method == "tools/call":
        if not isinstance(params, dict) or params.get("name") not in ALLOWED_TOOLS:
            raise web.HTTPForbidden(text="Tool unavailable in read-only staging")
    return method

async def mcp(request):
    # nginx checks client-cert identity. Never trust a public client assertion
    # as a substitute for its certificate validation.
    # Defend against local processes forging nginx verification headers.
    # This is *in addition to*, never a replacement for, nginx client TLS auth.
    edge_path=os.environ.get("CODEGYM_EDGE_SECRET_FILE","")
    if not edge_path:
        raise web.HTTPForbidden(text="HTTPS proxy not configured")
    edge=Path(edge_path).read_text(encoding="utf-8").strip()
    if not hmac.compare_digest(request.headers.get("X-CodeGym-Edge-Token", ""),edge):
        raise web.HTTPForbidden(text="Trusted HTTPS proxy required")
    if request.headers.get("X-CodeGym-Verified") != "SUCCESS":
        raise web.HTTPForbidden(text="Verified client certificate required")
    escaped_cert=request.headers.get("X-CodeGym-Client-Cert", "")
    if not escaped_cert or len(escaped_cert)>8000:
        raise web.HTTPForbidden(text="Missing OpenAI client certificate")
    try:
        cert=x509.load_pem_x509_certificate(unquote(escaped_cert).encode("ascii"))
        names=cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
        purposes=cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
        if "mtls.prod.connectors.openai.com" not in names or ExtendedKeyUsageOID.CLIENT_AUTH not in purposes:
            raise ValueError("Client cert purpose or SAN mismatch")
    except (ValueError, KeyError, x509.ExtensionNotFound, UnicodeError) as exc:
        raise web.HTTPForbidden(text="Client certificate not authorized") from exc
    if request.content_length is None:
        raise web.HTTPLengthRequired()
    if request.content_length > MAX_BYTES:
        raise web.HTTPRequestEntityTooLarge(max_size=MAX_BYTES, actual_size=request.content_length)
    try:
        msg = await request.json(loads=lambda s: json.loads(s,parse_constant=lambda _: (_ for _ in ()).throw(ValueError())))
    except (json.JSONDecodeError, ValueError, UnicodeError):
        raise web.HTTPBadRequest(text="Invalid JSON")
    method = validate(request, msg)
    if method=="tools/call":
        # Do not silently test a substitute emulator if the Windows agent
        # is misconfigured or offline; the ChatGPT plugin is Windows-only.
        if os.environ.get("CODEGYM_ROUTE_WINDOWS")!="1":
            raise web.HTTPServiceUnavailable(text="Windows diagnostic relay not configured")
        reply=await relay.call_windows(msg)
    else:
        reply = await asyncio.wait_for(asyncio.to_thread(m.handle, msg), timeout=24.0)
    if reply is None:
        return web.Response(status=202, headers={"Cache-Control":"no-store"})
    if method == "tools/list":
        result = reply.get("result", {})
        if isinstance(result, dict):
            result["tools"] = [tool for tool in result.get("tools", []) if tool.get("name") in ALLOWED_TOOLS]
    return web.json_response(reply,headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"})

async def status(request):
    return web.json_response({"ready":True,"mode":"mtls_readonly",
                              "source":"windows" if os.environ.get("CODEGYM_ROUTE_WINDOWS")=="1" else "ec2",
                              "relay_connected":relay.agent_connected(),
                              "public_tools":len(ALLOWED_TOOLS)})

app = web.Application(client_max_size=MAX_BYTES)
app.router.add_post("/mcp",mcp)
app.router.add_get("/agent",relay.agent_websocket)
app.router.add_get("/health",status)
if __name__ == "__main__":
    port=int(os.environ.get("CODEGYM_GATEWAY_PORT","8987"))
    if not 1024<=port<=65535:
        raise ValueError("Invalid gateway port")
    web.run_app(app, host="127.0.0.1", port=port, access_log=None)
