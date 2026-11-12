import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from mcp_launch_check import run

FIXTURE = str(Path(__file__).with_name("fixture_server.py"))
ROOT = Path(__file__).resolve().parents[1] / "scripts"


class LaunchCheckTests(unittest.TestCase):
    def probe(self, mode="good", minimum=1):
        return run([sys.executable, FIXTURE, mode], timeout=0.5, min_tools=minimum)

    def test_valid_legacy_peer(self):
        report = self.probe()
        self.assertTrue(report["passed"], report)
        self.assertEqual(len(report["checks"]), 8)
        self.assertTrue(report["shutdown"]["exited_on_stdin_close"])

    def test_modern_without_initialize(self):
        report = run([sys.executable, FIXTURE], protocol="2026-07-28")
        self.assertTrue(report["passed"], report)
        self.assertEqual(len(report["checks"]), 10)
        self.assertFalse(report["checks"][0]["details"]["initialize_sent"])

    def test_reject_modern_protocol_regressions(self):
        for mode in ["modern_bad_version", "modern_bad_details", "modern_missing_meta",
                     "modern_bad_advertisement", "modern_no_result_type"]:
            with self.subTest(mode=mode):
                report = run([sys.executable, FIXTURE, mode], protocol="2026-07-28")
                self.assertFalse(report["passed"], report)

    def test_paginated_catalog(self):
        report = self.probe("paginated", 2)
        self.assertTrue(report["passed"], report)
        self.assertEqual(report["checks"][1]["details"]["tool_count"], 2)

    def test_notifications_before_responses(self):
        self.assertTrue(self.probe("notification_before")["passed"])

    def test_stderr_cannot_block_process(self):
        self.assertTrue(self.probe("stderr_flood")["passed"])

    def test_catalog_digest_reproducible(self):
        a, b = self.probe(), self.probe()
        self.assertEqual(a["checks"][1]["details"]["catalog_sha256"],
                         b["checks"][1]["details"]["catalog_sha256"])

    def test_minimum_count(self):
        self.assertFalse(self.probe(minimum=25)["passed"])

    def test_failure_output_redacted(self):
        for mode in ("noisy", "bad_error", "bad_parse"):
            with self.subTest(mode=mode):
                report = self.probe(mode)
                self.assertFalse(report["passed"])
                self.assertNotIn("FIXTURE_SECRET", json.dumps(report))

    def test_timeout_is_bounded(self):
        start = time.monotonic()
        report = self.probe("hang")
        self.assertFalse(report["passed"])
        self.assertLess(time.monotonic() - start, 4)
        self.assertFalse(report["shutdown"]["exited_on_stdin_close"])

    def test_no_server_executable(self):
        self.assertFalse(run(["/no/such/mcp-launch-check-executable"])["passed"])

    def test_cli_json_report_and_exit_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "report.json"
            for mode, expected in [("good", 0), ("id", 1)]:
                process = subprocess.run(
                    [sys.executable, str(ROOT / "mcp_launch_check.py"),
                     "--out", str(out), "--", sys.executable, FIXTURE, mode],
                    capture_output=True, timeout=10,
                )
                self.assertEqual(process.returncode, expected)
                self.assertEqual(json.loads(out.read_text())["passed"], expected == 0)


def negative_case(mode, reason):
    def test(self):
        report = self.probe(mode)
        self.assertFalse(report["passed"], report)
        self.assertIn(reason, report["checks"][-1]["reason"])
    return test


for mode, reason in {
    "id": "ID mismatch", "version": "version not supported",
    "capability": "tools capability", "duplicate": "Duplicate tool",
    "page_duplicate": "Duplicate tool", "empty": "fewer tools",
    "missing_schema": "inputSchema", "cursor_loop": "repeated a cursor",
    "notification_reply": "ID mismatch", "crash": "closed stdout",
    "oversized": "Oversized", "both": "exactly one", "bad_rpc": "version",
    "nan": "invalid JSON", "server_request": "Unexpected server request",
    "bad_parse": "Wrong JSON-RPC error code", "bad_error": "Malformed JSON-RPC error",
}.items():
    setattr(LaunchCheckTests, "test_reject_" + mode, negative_case(mode, reason))


if __name__ == "__main__":
    unittest.main()
