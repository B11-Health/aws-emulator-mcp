"""Ensure the private gateway QA tool cannot send its token off localhost."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "remote_connector"))
from safety import RejectRedirects, validate_loopback_url, loopback_opener


class GatewayQALoopbackTests(unittest.TestCase):
    def test_accepts_exact_local_url_only(self):
        self.assertEqual(validate_loopback_url("http://127.0.0.1:8987/mcp"),
                         "http://127.0.0.1:8987/mcp")
        invalid = [
            "https://127.0.0.1:8987/mcp",
            "http://localhost:8987/mcp",
            "http://example.com:8987/mcp",
            "http://127.0.0.1:8987/mcp?secret=1",
            "http://127.0.0.1:8987/health",
            "http://user@127.0.0.1:8987/mcp",
            "http://127.0.0.1:80/mcp",
            "http://127.0.0.1:8987/mcp#fragment",
            " http://127.0.0.1:8987/mcp",
            None,
        ]
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_loopback_url(url)

    def test_redirects_never_forward_qa_token(self):
        from urllib.request import Request
        handler = RejectRedirects()
        req = Request("http://127.0.0.1:8987/mcp",
                      headers={"X-CodeGym-Edge-Token": "synthetic-secret"})
        for code in (301, 302, 303, 307, 308):
            self.assertIsNone(handler.redirect_request(
                req, None, code, "Moved",
                {"Location": "https://attacker.invalid/"}, "https://attacker.invalid/"))

    def test_proxy_environment_is_ignored(self):
        from unittest.mock import patch
        with patch("safety.build_opener") as builder:
            loopback_opener()
            self.assertEqual(builder.call_args[0][0].proxies, {})


if __name__ == "__main__":
    unittest.main()
