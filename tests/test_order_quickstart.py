"""Order workflow and local bootstrap QA; no live AWS calls."""
from contextlib import ExitStack
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"src"))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from aws_emulator_mcp import server as m
import generate_client_config

class OrderWorkflowTests(unittest.TestCase):
    def test_order_demo_recovery_and_cleanup(self):
        suffix="abcdef1234"
        order_id="order-"+suffix
        bucket="mcp-order-"+suffix
        table="mcp_order_"+suffix
        queue="mcp_order_"+suffix
        order={"id":order_id,"sku":"CODEGYM-DEMO-001","quantity":2,
               "total_usd":"42.00","status":"simulated"}
        expected=json.dumps(order,sort_keys=True,separators=(",",":"))
        fake={
            "health":{"running":True},
            "identity":{"Account":"000000000000"},
            "s3_get_object":[m.LocalError("Emulator HTTP 404: NoSuchKey"),
                             {"text":expected}],
            "dynamodb_get_item":{"Item":{"message":{"S":expected}}},
            "sqs_receive_messages":{"messages":[{"Body":order_id,"ReceiptHandle":"receipt"}]},
        }
        to_mock=[
            "health","identity","s3_create_bucket","dynamodb_create_table",
            "sqs_create_queue","s3_get_object","dynamodb_put_item",
            "s3_put_object","sqs_send_message","sqs_receive_messages",
            "sqs_delete_message","dynamodb_get_item","sqs_delete_queue",
            "dynamodb_delete_table","s3_delete_object","s3_delete_bucket",
        ]
        with ExitStack() as stack:
            stack.enter_context(patch("secrets.token_hex",return_value=suffix))
            mocks={}
            for name in to_mock:
                value=fake.get(name)
                if isinstance(value,list):
                    mocks[name]=stack.enter_context(patch.object(m,name,side_effect=value))
                else:
                    mocks[name]=stack.enter_context(patch.object(m,name,return_value=value))
            result=m.emulator_order_demo()
        self.assertTrue(result["passed"],result)
        self.assertEqual(result["order_id"],order_id)
        self.assertEqual(result["resources"],{"bucket":bucket,"table":table,"queue":queue})
        self.assertEqual(len(result["recovery"]),2)
        self.assertEqual(len(result["cleanup"]),4)
        mocks["sqs_delete_queue"].assert_called_once_with(queue)
        mocks["dynamodb_delete_table"].assert_called_once_with(table)
        mocks["s3_delete_object"].assert_called_once_with(bucket,"receipts/"+order_id+".json")
        mocks["s3_delete_bucket"].assert_called_once_with(bucket)

    def test_order_failure_still_cleans_own_resources(self):
        suffix="ab1ab1ab1a"
        with ExitStack() as stack:
            stack.enter_context(patch("secrets.token_hex",return_value=suffix))
            for name,value in [("health",{"running":True}),("identity",{"Account":"000000000000"})]:
                stack.enter_context(patch.object(m,name,return_value=value))
            for name in ("s3_create_bucket","dynamodb_create_table","sqs_create_queue",
                         "dynamodb_put_item","s3_put_object","sqs_delete_queue",
                         "dynamodb_delete_table","s3_delete_object","s3_delete_bucket"):
                stack.enter_context(patch.object(m,name))
            stack.enter_context(patch.object(m,"s3_get_object",side_effect=m.LocalError("Emulator HTTP 404: missing")))
            stack.enter_context(patch.object(m,"sqs_send_message",side_effect=m.LocalError("intentional local failure")))
            result=m.emulator_order_demo()
        self.assertFalse(result["passed"])
        self.assertIn("intentional",result["error"])
        self.assertEqual(len(result["cleanup"]),4)
        self.assertTrue(all(x["passed"] for x in result["cleanup"]))

    def test_doctor_does_not_expose_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            cred=Path(tmp);(cred/"ca.pem").write_text("fake-test-ca")
            with patch.object(m,"CREDDIR",cred),\
                 patch.object(m,"emulator_binary",return_value="dummy-binary"),\
                 patch.object(m.subprocess,"run") as run,\
                 patch.object(m,"emulator_keys",return_value=("EMULATOR_TEST","private_test_secret","")),\
                 patch.object(m,"health",return_value={"running":True}),\
                 patch.object(m,"identity",return_value={"Account":"000000000000"}):
                run.return_value.returncode=0
                run.return_value.stdout="Version: 1.0.322"
                run.return_value.stderr=""
                result=m.doctor()
        self.assertTrue(result["ready"])
        self.assertEqual(len(result["checks"]),6)
        self.assertNotIn("private_test_secret",json.dumps(result))
        self.assertTrue(result["account_verified"])

class QuickstartTests(unittest.TestCase):
    def test_linux_client_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);script=p/"scripts"/"serve_wsl.sh"
            script.parent.mkdir();script.write_text("#!/bin/bash\n")
            configs=generate_client_config.render(p,"linux")
            self.assertEqual(configs["mcp"]["mcpServers"]["aws-emulator-local"]["command"],"bash")
            self.assertEqual(configs["vscode"]["servers"]["aws-emulator-local"]["type"],"stdio")
            self.assertTrue(configs["mcp"]["mcpServers"]["aws-emulator-local"]["args"][0].endswith("serve_wsl.sh"))

    def test_wsl_config_prevents_windows_path(self):
        if sys.platform=="win32":
            with tempfile.TemporaryDirectory() as tmp:
                p=Path(tmp);script=p/"scripts"/"serve_wsl.sh"
                script.parent.mkdir();script.write_text("#!/bin/bash\n")
                with self.assertRaisesRegex(ValueError,"inside WSL"):
                    generate_client_config.render(p,"windows-wsl")

    @unittest.skipIf(sys.platform=="win32","Bash validation runs on Linux/WSL")
    def test_quickstart_rejects_invalid_custom_port_before_install(self):
        path=Path(__file__).resolve().parents[1]/"scripts"/"quickstart_linux.sh"
        subprocess.run(["bash","-n",str(path)],check=True,timeout=4)
        env=dict(os.environ,AWS_EMULATOR_PORT="80")
        result=subprocess.run(["bash",str(path)],env=env,
                              capture_output=True,text=True,timeout=4)
        self.assertEqual(result.returncode,2)
        self.assertIn("Invalid AWS_EMULATOR_PORT",result.stderr)

    def test_quickstart_port_is_propagated_to_process_launch(self):
        s=(Path(__file__).resolve().parents[1]/"scripts"/"quickstart_linux.sh").read_text(encoding="utf-8")
        self.assertIn('PORT="$'+'{AWS_EMULATOR_PORT:-9297}"',s)
        self.assertIn('"$BIN" -p "$PORT" --telemetry off',s)

    def test_rootless_installer_verifies_signature(self):
        p=Path(__file__).resolve().parents[1]/"scripts"/"install_wsl.sh"
        contents=p.read_text()
        self.assertIn('gpg --batch',contents)
        self.assertIn('--verify',contents)
        self.assertIn('98BCF336A3BE53B734E967C52E5BF49BD940F624',contents)

if __name__=="__main__":
    unittest.main()
