"""Security, stateless MCP 2026, and AWS Emulator SQS regression tests."""
import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"src"))
from aws_emulator_mcp import server as m

class HardeningTests(unittest.TestCase):
    def rpc(self,method,params=None,id_=1):
        return m.handle({"jsonrpc":"2.0","id":id_,"method":method,"params":params or {}})

    def modern_params(self,extra=None,version="2026-07-28"):
        return {"_meta":{
            m.META_VERSION:version,m.META_CAPS:{}},
            **(extra or {})}

    def test_rejects_every_redirect(self):
        handler=m.RejectRedirects()
        from urllib.request import Request
        request=Request(m.ENDPOINT+"/")
        for code in (301,302,303,307,308):
            self.assertIsNone(handler.redirect_request(request,None,code,"Moved",
                     {"Location":"https://aws.amazon.com/"}, "https://aws.amazon.com/"))

    def test_local_client_has_no_proxy(self):
        context=object()
        with patch.object(m,"HTTPSHandler",return_value=object()):
            with patch.object(m,"build_opener") as opener:
                m._local_opener(context)
        self.assertEqual(opener.call_args[0][0].proxies,{})
        self.assertIs(opener.call_args[0][2],m.RejectRedirects)

    def test_parse_errors_are_jsonrpc(self):
        for payload in (b"{broken",b"not-json",b'{"jsonrpc":"2.0",',b'{"number":NaN}'):
            r=m.parse_line(payload)
            self.assertEqual(r["error"]["code"],-32700)

    def test_non_object_request_is_invalid(self):
        for payload in (b"[]",b"null",b'["tools/list"]',b"42"):
            self.assertEqual(m.parse_line(payload)["error"]["code"],-32600)

    def test_invalid_message_id(self):
        request={"jsonrpc":"2.0","id":True,"method":"tools/list"}
        self.assertEqual(m.handle(request)["error"]["code"],-32600)
        request["id"]=1.1
        self.assertEqual(m.handle(request)["error"]["code"],-32600)

    def test_null_request_id_has_response(self):
        r=self.rpc("tools/list",id_=None)
        self.assertIn("result",r)
        self.assertIsNone(r["id"])

    def test_notifications_are_silent(self):
        self.assertIsNone(m.handle({"jsonrpc":"2.0","method":"notifications/initialized"}))
        self.assertIsNone(m.handle({"jsonrpc":"2.0","method":"notifications/cancelled","params":{}}))

    def test_unknown_method(self):
        self.assertEqual(self.rpc("cloud/delete-everything")["error"]["code"],-32601)

    def test_args_fail_closed_on_wrong_types(self):
        invalid=[
            ("s3_create_bucket",{"bucket":False}),
            ("s3_put_object",{"bucket":"test123","key":"x","text":123}),
            ("dynamodb_put_item",{"table":"abc","item_id":7,"message":"ok"}),
            ("sqs_create_queue",{"queue":["queue"]}),
            ("sqs_send_message",{"queue":"good","message":""}),
            ("sqs_receive_messages",{"queue":"good","endpoint":"https://aws.amazon.com"}),
            ("s3_put_object",{"bucket":"test123","key":"a","text":"x"*65537}),
        ]
        for name,args in invalid:
            with self.subTest(name=name,args=str(args)[:60]):
                r=self.rpc("tools/call",{"name":name,"arguments":args})
                self.assertEqual(r["error"]["code"],-32602)

    def test_version_mismatch_is_explicit(self):
        r=self.rpc("tools/list",self.modern_params(version="1900-01-01"))
        self.assertEqual(r["error"]["code"],-32022)
        self.assertIn("2026-07-28",r["error"]["data"]["supported"])

    def test_stateless_discovery(self):
        r=self.rpc("server/discover",self.modern_params())
        d=r["result"]
        self.assertEqual(d["resultType"],"complete")
        self.assertEqual(d["cacheScope"],"public")
        self.assertEqual(d["_meta"][m.META_SERVER]["name"],"aws-emulator-mcp")
        self.assertIn("2026-07-28",d["supportedVersions"])

    def test_stateless_tools_list_has_metadata(self):
        r=self.rpc("tools/list",self.modern_params())
        d=r["result"]
        self.assertEqual(len(d["tools"]),25)
        self.assertEqual(d["resultType"],"complete")
        self.assertIsInstance(d["ttlMs"],int)
        self.assertEqual(d["cacheScope"],"public")
        self.assertIn(m.META_SERVER,d["_meta"])

    def test_modern_requires_capabilities(self):
        r=self.rpc("tools/list",{"_meta":{m.META_VERSION:"2026-07-28"}})
        self.assertEqual(r["error"]["code"],-32602)

    def test_modern_does_not_support_ping(self):
        r=self.rpc("ping",self.modern_params())
        self.assertEqual(r["error"]["code"],-32601)

    def test_legacy_initialize_still_supported(self):
        r=self.rpc("initialize",{"protocolVersion":"2025-11-25"})
        self.assertEqual(r["result"]["protocolVersion"],"2025-11-25")

    def test_oversized_request_rejected(self):
        r=m.parse_line(b"a"*(m.MAX_LINE_BYTES+1))
        self.assertEqual(r["error"]["code"],-32600)

    def test_unexpected_exception_is_not_leaked(self):
        with patch.dict(m.FUNCTIONS,{"emulator_health":lambda:1/0}):
            r=self.rpc("tools/call",{"name":"emulator_health","arguments":{}})
        self.assertTrue(r["result"]["isError"])
        self.assertNotIn("division by zero",r["result"]["content"][0]["text"])

    def test_sqs_json_target_is_signed_on_local_endpoint(self):
        with patch.object(m,"request",return_value={"body":b'{"MessageId":"abc"}'}) as req:
            data=m.sqs_query("SendMessage",{"MessageBody":"hi"})
        self.assertEqual(data["MessageId"],"abc")
        self.assertEqual(req.call_args.kwargs["service"],"sqs")
        self.assertEqual(req.call_args.kwargs["headers"]["x-amz-target"],"AmazonSQS.SendMessage")

    def test_sqs_list_strips_real_aws_urls(self):
        with patch.object(m,"sqs_query",return_value={"QueueUrls":[
            "https://sqs.us-east-1.amazonaws.com/000000000000/myqueue",
            "https://example.invalid/1234/other"]}):
            result=m.sqs_list_queues()
        self.assertEqual(result,{"queues":["myqueue"]})

    def test_sqs_create_returns_only_loopback(self):
        with patch.object(m,"sqs_query",return_value={
            "QueueUrl":"https://sqs.us-east-1.amazonaws.com/000000000000/samplequeue"}):
            result=m.sqs_create_queue("samplequeue")
        self.assertEqual(result["queue_url"],m.ENDPOINT+"/000000000000/samplequeue")

    def test_emulator_self_test_failure_still_cleans_resources(self):
        with patch.object(m,"health",return_value={"running":True}),\
             patch.object(m,"identity",return_value={"Account":"000000000000"}),\
             patch.object(m,"s3_create_bucket"),\
             patch.object(m,"s3_put_object"),\
             patch.object(m,"s3_get_object",return_value={"text":"checked-local"}),\
             patch.object(m,"s3_list_objects",return_value={"keys":["selftest.txt"]}),\
             patch.object(m,"dynamodb_create_table"),\
             patch.object(m,"dynamodb_put_item"),\
             patch.object(m,"dynamodb_get_item",return_value={"Item":{"message":{"S":"ok"}}}),\
             patch.object(m,"sqs_create_queue",side_effect=m.LocalError("intentional injection")),\
             patch.object(m,"s3_delete_bucket") as delete_bucket,\
             patch.object(m,"dynamodb_delete_table") as delete_table,\
             patch.object(m,"s3_delete_object") as delete_object:
            result=m.emulator_self_test()
        self.assertFalse(result["passed"])
        self.assertIn("intentional injection",result["error"])
        delete_bucket.assert_called_once()
        delete_table.assert_called_once()
        delete_object.assert_called_once()

    def test_real_http_redirect_does_not_follow(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading
        import ssl
        hits=[]
        class RedirectServer(BaseHTTPRequestHandler):
            def log_message(self,*a):pass
            def do_GET(self):
                hits.append(self.path)
                self.send_response(302 if self.path=="/__admin/health" else 200)
                if self.path=="/__admin/health":
                    self.send_header("Location","/sink")
                self.end_headers()
        srv=ThreadingHTTPServer(("127.0.0.1",0),RedirectServer)
        thread=threading.Thread(target=srv.serve_forever,daemon=True)
        thread.start()
        try:
            with patch.object(m,"ENDPOINT",f"http://127.0.0.1:{srv.server_port}"),\
                 patch.object(m,"ssl_context",return_value=ssl.create_default_context()):
                with self.assertRaisesRegex(m.LocalError,"Emulator HTTP 302"):
                    m.request("GET","/__admin/health")
            self.assertEqual(hits,["/__admin/health"])
        finally:
            srv.shutdown();srv.server_close();thread.join(timeout=3)

    def test_failing_selftest_is_mcp_tool_error(self):
        with patch.dict(m.FUNCTIONS,{"emulator_self_test":lambda:{"passed":False}}):
            result=self.rpc("tools/call",{"name":"emulator_self_test","arguments":{}})
        self.assertTrue(result["result"]["isError"])


if __name__=="__main__":unittest.main()
