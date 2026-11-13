import datetime
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from aws_emulator_mcp import server as m

class ProtocolTests(unittest.TestCase):
    def test_initialize(self):
        out=m.handle({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}})
        self.assertEqual(out["result"]["serverInfo"]["name"],"aws-emulator-mcp")
        self.assertIn("tools",out["result"]["capabilities"])

    def test_tool_catalog(self):
        out=m.handle({"jsonrpc":"2.0","id":2,"method":"tools/list"})
        names={t["name"] for t in out["result"]["tools"]}
        self.assertIn("emulator_start",names)
        self.assertIn("s3_put_object",names)
        self.assertIn("dynamodb_get_item",names)
        self.assertIn("s3_delete_bucket",names)
        self.assertIn("dynamodb_list_tables",names)
        self.assertIn("sqs_send_message",names)
        self.assertIn("emulator_self_test",names)
        self.assertEqual(len(names),29)

    def test_notifications_have_no_response(self):
        self.assertIsNone(m.handle({"jsonrpc":"2.0","method":"notifications/initialized"}))

    def test_unknown_tool(self):
        out=m.handle({"jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"delete_real_cloud_resources"}})
        self.assertEqual(out["error"]["code"],-32602)

    def test_extra_arguments_rejected(self):
        out=m.handle({"jsonrpc":"2.0","id":4,"method":"tools/call",
            "params":{"name":"s3_create_bucket","arguments":{"bucket":"test123","endpoint":"https://aws.amazon.com"}}})
        self.assertEqual(out["error"]["code"],-32602)

    def test_credentials_must_be_emulator_generated(self):
        with tempfile.TemporaryDirectory() as root:
            d=Path(root)
            (d/"emulator_credentials").write_text("[default]\naws_access_key_id=AKIAREALKEY\naws_secret_access_key=bad\n")
            with patch.object(m,"CREDDIR",d):
                with self.assertRaisesRegex(m.LocalError,"Refusing credentials"):
                    m.emulator_keys()

    def test_signature_is_local_and_deterministic(self):
        with tempfile.TemporaryDirectory() as root:
            d=Path(root)
            (d/"emulator_credentials").write_text("[default]\naws_access_key_id=EMULATORTEST\naws_secret_access_key=only-local-test\n")
            with patch.object(m,"CREDDIR",d):
                now=datetime.datetime(2026,11,11,tzinfo=datetime.timezone.utc)
                headers,path,query=m.signed_headers("s3","PUT","/bucket/a b",{},b"sample",{"content-type":"text/plain"},now)
                self.assertEqual(path,"/bucket/a%20b")
                self.assertEqual(headers["host"],f"127.0.0.1:{m.PORT}")
                self.assertIn("EMULATORTEST/20261111/us-east-1/s3/aws4_request",headers["authorization"])
                self.assertIn("Signature=",headers["authorization"])
                self.assertEqual(headers["x-amz-date"],"20261111T000000Z")

    def test_validate_names(self):
        for invalid in ["AA","bad..bucket","Capital","-bad","a/b"]:
            with self.assertRaises(m.LocalError):
                m.check_bucket(invalid)
        self.assertEqual(m.check_bucket("my-local-bucket"),"my-local-bucket")

    def test_health_fails_closed_without_cert(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(m,"CREDDIR",Path(root)):
                self.assertFalse(m.health()["running"])

    def test_stdio_process_roundtrip(self):
        exe=Path(__file__).resolve().parents[1] / "src" / "aws_emulator_mcp" / "server.py"
        requests=[
          {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}},
          {"jsonrpc":"2.0","method":"notifications/initialized"},
          {"jsonrpc":"2.0","id":2,"method":"tools/list"},
        ]
        data="".join(json.dumps(x)+"\n" for x in requests)
        p=subprocess.run([sys.executable,"-u",str(exe)],input=data,capture_output=True,text=True,timeout=5)
        self.assertEqual(p.returncode,0,p.stderr)
        output=[json.loads(x) for x in p.stdout.splitlines()]
        self.assertEqual(len(output),2)
        self.assertEqual(len(output[1]["result"]["tools"]),29)

    def test_no_nonlocal_url_setting(self):
        self.assertEqual(m.ENDPOINT,f"https://127.0.0.1:{m.PORT}")
        self.assertNotIn("endpoint",m.TOOLS[0]["inputSchema"]["properties"])

    def test_dynamodb_create_waits_until_active(self):
        fake=[
            {"TableDescription":{"TableStatus":"CREATING"}},
            {"Table":{"TableStatus":"CREATING"}},
            {"Table":{"TableStatus":"ACTIVE","TableName":"testtable"}},
        ]
        with patch.object(m,"dynamo",side_effect=fake) as call, patch.object(m.time,"sleep"):
            result=m.dynamodb_create_table("testtable")
        self.assertEqual(result["description"]["TableStatus"],"ACTIVE")
        self.assertEqual(call.call_count,3)

    def test_dynamodb_delete_waits_until_gone(self):
        fake=[
            {"TableDescription":{"TableStatus":"DELETING"}},
            {"TableNames":["testtable"]},
            {"TableNames":[]},
        ]
        with patch.object(m,"dynamo",side_effect=fake) as call, patch.object(m.time,"sleep"):
            result=m.dynamodb_delete_table("testtable")
        self.assertTrue(result["deleted"])
        self.assertEqual(call.call_count,3)

if __name__=="__main__": unittest.main()
