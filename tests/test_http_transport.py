"""Real localhost HTTP transport regression suite (no AWS calls)."""
import json
from pathlib import Path
import sys
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"src"))
from aws_emulator_mcp.http_transport import create_server
from aws_emulator_mcp import server as m

class HttpTransportTests(unittest.TestCase):
    def setUp(self):
        self.token="t"*48
        self.server=create_server(port=0,token=self.token)
        self.port=self.server.server_port
        self.url=f"http://127.0.0.1:{self.port}/mcp"
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def post(self,payload,extra=None,auth=True,method="POST"):
        headers={"Content-Type":"application/json",
                 "Accept":"application/json, text/event-stream"}
        if auth:headers["Authorization"]="Bearer "+self.token
        if extra:headers.update(extra)
        if isinstance(payload,dict):payload=json.dumps(payload).encode()
        request=Request(self.url,data=payload,method=method,headers=headers)
        try:
            with urlopen(request,timeout=3) as response:
                data=response.read()
                return response.status,json.loads(data) if data else None,dict(response.headers)
        except HTTPError as error:
            data=error.read()
            return error.code,json.loads(data) if data else None,dict(error.headers)

    def test_unauthorized(self):
        status,body,_=self.post({"jsonrpc":"2.0","id":1,"method":"tools/list"},auth=False)
        self.assertEqual(status,401)

    def test_invalid_origin_rejected(self):
        status,body,_=self.post({"jsonrpc":"2.0","id":1,"method":"tools/list"},
                               {"Origin":"https://example.invalid"})
        self.assertEqual(status,403)

    def test_invalid_host_rejected(self):
        status,body,_=self.post({"jsonrpc":"2.0","id":1,"method":"tools/list"},
                               {"Host":"evil.example"})
        self.assertEqual(status,403)

    def test_get_not_supported(self):
        req=Request(self.url,headers={"Authorization":"Bearer "+self.token},method="GET")
        with self.assertRaises(HTTPError) as cm:urlopen(req,timeout=3)
        self.assertEqual(cm.exception.code,405)

    def test_legacy_tools_list(self):
        status,body,headers=self.post({"jsonrpc":"2.0","id":1,"method":"tools/list"})
        self.assertEqual(status,200)
        self.assertEqual(len(body["result"]["tools"]),27)
        self.assertEqual(headers.get("Cache-Control"),"no-store")

    def test_modern_tools_list(self):
        params={"_meta":{m.META_VERSION:"2026-07-28",m.META_CAPS:{}}}
        status,body,_=self.post({"jsonrpc":"2.0","id":1,"method":"tools/list","params":params},
                {"MCP-Protocol-Version":"2026-07-28","Mcp-Method":"tools/list"})
        self.assertEqual(status,200,body)
        self.assertEqual(body["result"]["resultType"],"complete")
        self.assertEqual(len(body["result"]["tools"]),27)

    def test_modern_requires_version_header(self):
        params={"_meta":{m.META_VERSION:"2026-07-28",m.META_CAPS:{}}}
        status,body,_=self.post({"jsonrpc":"2.0","id":1,"method":"tools/list","params":params})
        self.assertEqual(status,400)
        self.assertEqual(body["error"]["code"],-32602)

    def test_method_header_mismatch(self):
        status,body,_=self.post({"jsonrpc":"2.0","id":1,"method":"tools/list"},
                               {"Mcp-Method":"tools/call"})
        self.assertEqual(status,400)

    def test_invalid_json_response(self):
        status,body,_=self.post(b"broken JSON")
        self.assertEqual(status,400)
        self.assertEqual(body["error"]["code"],-32700)

    def test_notifications_are_202(self):
        status,body,_=self.post({"jsonrpc":"2.0","method":"notifications/initialized"})
        self.assertEqual(status,202)
        self.assertIsNone(body)

    def test_requires_both_mcp_accept_types(self):
        status,body,_=self.post({"jsonrpc":"2.0","id":1,"method":"tools/list"},
                               {"Accept":"application/json"})
        self.assertEqual(status,406)

    def test_bearer_required_at_startup(self):
        with self.assertRaises(ValueError):create_server(port=0,token="short")

    def test_modern_header_without_meta_is_rejected(self):
        status,body,_=self.post({"jsonrpc":"2.0","id":1,"method":"tools/list"},
                               {"MCP-Protocol-Version":"2026-07-28"})
        self.assertEqual(status,400)
        self.assertEqual(body["error"]["code"],-32602)

    def test_tool_name_header_mismatch(self):
        status,body,_=self.post({"jsonrpc":"2.0","id":1,"method":"tools/call",
                                 "params":{"name":"emulator_health","arguments":{}}},
                               {"Mcp-Name":"emulator_stop"})
        self.assertEqual(status,400)
        self.assertEqual(body["error"]["code"],-32602)


    def test_modern_requires_method_header(self):
        meta={"_meta":{m.META_VERSION:"2026-07-28",m.META_CAPS:{}}}
        code,body,_=self.post({"jsonrpc":"2.0","id":4,"method":"tools/list","params":meta},
            {"MCP-Protocol-Version":"2026-07-28"})
        self.assertEqual(code,400)
        self.assertEqual(body["error"]["code"],-32020)

    def test_modern_requires_name_header_for_tool(self):
        meta={"_meta":{m.META_VERSION:"2026-07-28",m.META_CAPS:{}},
              "name":"emulator_health","arguments":{}}
        code,body,_=self.post({"jsonrpc":"2.0","id":5,"method":"tools/call","params":meta},
            {"MCP-Protocol-Version":"2026-07-28","Mcp-Method":"tools/call"})
        self.assertEqual(code,400)
        self.assertEqual(body["error"]["code"],-32020)

    def test_modern_accepts_named_tool_call(self):
        meta={"_meta":{m.META_VERSION:"2026-07-28",m.META_CAPS:{}},
              "name":"emulator_status","arguments":{}}
        code,body,_=self.post({"jsonrpc":"2.0","id":6,"method":"tools/call","params":meta},
            {"MCP-Protocol-Version":"2026-07-28","Mcp-Method":"tools/call",
             "Mcp-Name":"emulator_status"})
        self.assertEqual(code,200)
        self.assertFalse(body["result"]["isError"])

if __name__=="__main__":unittest.main()
