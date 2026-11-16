"""Boundaries and evidence for the opt-in local source verification command."""
import hashlib
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from aws_emulator_mcp import app_debug, app_verify

FIXTURES = ROOT / "examples" / "byo-order-handler"


def envelope(source):
    return {
        "schemaVersion": 1,
        "source": source,
        "sourceSha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
    }


class AppVerifyTests(unittest.TestCase):
    def test_bundled_caller_source_is_rich_and_does_not_contain_credentials(self):
        for name in ("buggy.py", "fixed.py"):
            text = (FIXTURES / name).read_text(encoding="utf-8")
            self.assertIn("def submit_order", text)
            for field in ("tenantId", "customerId", "totalCents", "lineCount"):
                self.assertIn(field, text)
            self.assertNotIn("AWS_SECRET_ACCESS_KEY", text)
            self.assertEqual(app_verify.validate(envelope(text))[0], text)

    def test_exact_envelope_hash_and_size_are_required(self):
        text = (FIXTURES / "fixed.py").read_text()
        correct = envelope(text)
        self.assertEqual(app_verify.validate(correct)[1], correct["sourceSha256"])
        for payload in [
            None, [], {}, {"schemaVersion": 1, "source": text},
            {**correct, "schemaVersion": True},
            {**correct, "schemaVersion": 2},
            {**correct, "sourceSha256": "f" * 64},
            {**correct, "sourceSha256": "F" * 64},
            {**correct, "sourceSha256": 17},
            {**correct, "source": "\x00valid code"},
            {**correct, "source": "a" * (20 * 1024 + 1)},
            {**correct, "source": " " * 10},
            {**correct, "unexpected": "danger"},
        ]:
            with self.subTest(payload=str(payload)[:40]):
                with self.assertRaises(app_verify.LocalAppError):
                    app_verify.validate(payload)

    def test_source_loader_requires_explicit_docker_and_injected_function(self):
        source = "def submit_order(dynamodb, s3, sqs, *, table, bucket, queue_url, order):\n    return {'accepted': False}\n"
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "0"}):
            with self.assertRaises(app_verify.LocalAppError):
                app_verify.load_handler(source)
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "1"}):
            handler = app_verify.load_handler(source)
            self.assertFalse(handler(None, None, None, table="", bucket="",
                                     queue_url="", order={})["accepted"])
            with self.assertRaisesRegex(app_verify.LocalAppError, "must define"):
                app_verify.load_handler("pass")
            with self.assertRaisesRegex(app_verify.LocalAppError, "requires injected"):
                app_verify.load_handler("def submit_order(): return True")

    def test_source_output_is_suppressed_on_import(self):
        source = (
            "print('PRIVATE_FROM_SOURCE')\n"
            "def submit_order(dynamodb, s3, sqs, *, table, bucket, queue_url, order):\n"
            "    return {'accepted':False}\n"
        )
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "1"}):
            from io import StringIO
            with patch("sys.stdout", new_callable=StringIO) as out:
                app_verify.load_handler(source)
                self.assertNotIn("PRIVATE_FROM_SOURCE", out.getvalue())

    def test_real_bundled_app_debug_still_rejects_untrusted_custom_variant(self):
        from aws_emulator_mcp.server import LocalError
        with self.assertRaisesRegex(LocalError, "Unknown"):
            app_debug._run_variant("local")

    def test_source_evidence_does_not_include_raw_source_or_private_data(self):
        source = (
            "def submit_order(dynamodb,s3,sqs,*,table,bucket,queue_url,order):\n"
            "    print('SENSITIVE_PAYLOAD_NEVER_ECHO')\n"
            "    return {'accepted': False}\n"
        )
        result = {
            "passed": False, "verifiedAccount": "000000000000",
            "emulatorVersion": "synthetic-fake",
            "observed": {"acceptedSubmissions": 0, "queueEvents": 0},
            "assertions": [{"name": "duplicate rejected", "passed": True}],
            "cleanup": [{"name": "cleanup", "passed": True}],
            "error": "Local handler exception; check the synthetic assertions and source",
        }
        with patch.dict(os.environ, {"AWS_EMULATOR_MCP_ISOLATED_LAB": "1"}), \
             patch("aws_emulator_mcp.server.doctor",
                   return_value={"ready": True}), \
             patch("aws_emulator_mcp.server.identity",
                   return_value={"Account": "000000000000"}), \
             patch.object(app_debug, "_run_variant", return_value=result) as run:
            evidence = app_verify.execute(envelope(source))
        self.assertEqual(run.call_args.args, ("local",))
        self.assertTrue(callable(run.call_args.kwargs["handler"]))
        serialized = json.dumps(evidence)
        self.assertNotIn("SENSITIVE_PAYLOAD_NEVER_ECHO", serialized)
        self.assertNotIn(source, serialized)
        self.assertTrue(evidence["accountVerified"])
        self.assertEqual(evidence["sourceSha256"], envelope(source)["sourceSha256"])
        self.assertFalse(evidence["passed"])

    def test_remote_mcp_does_not_offer_user_source_execution(self):
        from aws_emulator_mcp import server
        tools = {x["name"] for x in server.TOOLS}
        self.assertNotIn("app_verify", tools)
        self.assertNotIn("app_verify_run", tools)
        self.assertNotIn("exec_source", tools)

    def test_cli_and_docker_do_not_forward_source_as_argv_or_host_mount(self):
        cli = (ROOT / "bin/aws-emulator-mcp.mjs").read_text()
        entrypoint = (ROOT / "docker/entrypoint.sh").read_text()
        self.assertIn("dockerArgs('app-verify')", cli)
        self.assertIn("JSON.stringify(envelope)", cli)
        self.assertIn("lstatSync(file)", cli)
        self.assertIn("info.isSymbolicLink()", cli)
        self.assertIn("'--network', 'none'", cli)
        self.assertIn("'--cap-drop', 'ALL'", cli)
        self.assertIn("'--security-opt', 'no-new-privileges'", cli)
        self.assertIn("app-verify) timeout", entrypoint)
        self.assertNotIn("docker cp ", cli)
        self.assertNotIn("--volume", cli)


if __name__ == "__main__":
    unittest.main()
