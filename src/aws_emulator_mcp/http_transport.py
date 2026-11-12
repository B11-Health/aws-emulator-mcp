"""Opt-in authenticated Streamable HTTP MCP transport, loopback only.

Never expose directly to the internet. Use stdio by default; HTTP requires a
fresh random bearer token and explicit user opt-in. The emulator itself is not
made reachable via this transport.
"""
from __future__ import annotations
import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from aws_emulator_mcp import server as m

DEFAULT_PORT=8766

def create_server(port=None,token=None):
    port=DEFAULT_PORT if port is None else port
    if not isinstance(port,int) or not (port==0 or 1024<=port<=65535):
        raise ValueError("Invalid local MCP HTTP port")
    token=os.environ.get("AWS_MCP_BEARER_TOKEN","") if token is None else token
    if not isinstance(token,str) or len(token)<32:
        raise ValueError("AWS_MCP_BEARER_TOKEN must contain at least 32 characters")

    class Handler(BaseHTTPRequestHandler):
        server_version="AWS-Emulator-MCP/0.3"
        sys_version=""
        protocol_version="HTTP/1.1"

        def log_message(self,format,*args):
            # Never log headers, token, request bodies, account data or secrets.
            pass

        def _send(self,status,body=None):
            raw=b"" if body is None else json.dumps(body,ensure_ascii=False,separators=(",",":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(raw)))
            self.send_header("Cache-Control","no-store")
            self.send_header("X-Content-Type-Options","nosniff")
            self.send_header("Connection","close")
            if status==405:self.send_header("Allow","POST")
            self.end_headers()
            if raw:self.wfile.write(raw)

        def _authorized(self):
            host=self.headers.get("Host","")
            if host not in (f"127.0.0.1:{port}",f"localhost:{port}"):
                self._send(403,{"error":"Invalid Host header"})
                return False
            origin=self.headers.get("Origin")
            if origin is not None and origin not in (
                    f"http://127.0.0.1:{port}",f"http://localhost:{port}"):
                self._send(403,{"error":"Origin not allowed"})
                return False
            candidate=self.headers.get("Authorization","")
            if not hmac.compare_digest(candidate,"Bearer "+token):
                self._send(401,{"error":"Unauthorized"})
                return False
            return True

        def do_GET(self):
            if not self._authorized():return
            self._send(405,{"error":"Streamable HTTP GET is unsupported; use POST"})

        def do_DELETE(self):
            if not self._authorized():return
            self._send(405,{"error":"MCP sessions are not supported"})

        def do_OPTIONS(self):
            self._send(405,{"error":"Browser CORS is not enabled"})

        def do_POST(self):
            if self.path!="/mcp":
                self._send(404,{"error":"Unknown path"})
                return
            if not self._authorized():return
            accepted=self.headers.get("Accept","")
            if "application/json" not in accepted or "text/event-stream" not in accepted:
                self._send(406,{"error":"MCP Accept header must allow JSON and SSE"})
                return
            content_type=self.headers.get("Content-Type","").split(";",1)[0].strip().lower()
            if content_type!="application/json":
                self._send(415,{"error":"Content-Type must be application/json"})
                return
            size_str=self.headers.get("Content-Length","")
            if not size_str.isdecimal():
                self._send(411,{"error":"Content-Length required"})
                return
            size=int(size_str)
            if size>m.MAX_LINE_BYTES:
                self._send(413,{"error":"Request too large"})
                return
            raw=self.rfile.read(size)
            try:
                msg=json.loads(raw)
            except (ValueError,UnicodeError):
                self._send(400,m._rpc_error(None,-32700,"Parse error"))
                return
            if not isinstance(msg,dict):
                self._send(400,m._rpc_error(None,-32600,"Invalid Request"))
                return
            provided=self.headers.get("MCP-Protocol-Version")
            params=msg.get("params") or {}
            meta=params.get("_meta") if isinstance(params,dict) else None
            version=meta.get(m.META_VERSION) if isinstance(meta,dict) else None
            if version=="2026-07-28" and provided!="2026-07-28":
                self._send(400,m._rpc_error(msg.get("id"),-32602,
                           "Modern MCP-Protocol-Version header required"))
                return
            if provided and version and provided!=version:
                self._send(400,m._rpc_error(msg.get("id"),-32602,
                           "MCP protocol version header mismatch"))
                return
            if provided=="2026-07-28" and version!="2026-07-28":
                self._send(400,m._rpc_error(msg.get("id"),-32602,
                           "Missing modern protocol metadata"))
                return
            name_header=self.headers.get("Mcp-Name")
            name_value=params.get("name") if isinstance(params,dict) else None
            if name_header is not None and name_header!=name_value:
                self._send(400,m._rpc_error(msg.get("id"),-32602,
                           "MCP tool name header mismatch"))
                return
            method_header=self.headers.get("Mcp-Method")
            if method_header and method_header!=msg.get("method"):
                self._send(400,m._rpc_error(msg.get("id"),-32602,
                           "MCP method header mismatch"))
                return
            result=m.handle(msg)
            if result is None:
                self._send(202)
            elif "error" in result and result["error"]["code"]==-32022:
                self._send(400,result)
            else:
                self._send(200,result)

    server=ThreadingHTTPServer(("127.0.0.1",port),Handler)
    port=server.server_port  # Resolve OS-assigned ephemeral port for tests.
    server.daemon_threads=True
    return server

def main():
    port_str=os.environ.get("AWS_MCP_HTTP_PORT",str(DEFAULT_PORT))
    try:
        port=int(port_str)
        server=create_server(port=port)
    except (ValueError,OSError) as exc:
        print("MCP HTTP startup refused: "+str(exc),file=sys.stderr)
        return 2
    print(f"AWS Emulator MCP HTTP listening on 127.0.0.1:{port} (bearer auth on)",
          file=sys.stderr,flush=True)
    try: server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:pass
    finally:server.server_close()
    return 0

if __name__=="__main__":sys.exit(main())
