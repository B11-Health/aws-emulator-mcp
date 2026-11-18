"""No cloud credentials, cloud network, or real AWS: synthetic official files only."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import socket
import sys
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from aws_emulator_mcp import official_session_identity as target

ACCOUNT = {"Account": "000000000000", "Arn": "arn:aws:iam::000000000000:user/emulator"}


class OfficialSessionIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(prefix="official-sts-unit-")
        self.addCleanup(self.temp.cleanup)
        self.port = 19497
        self.root = Path(self.temp.name) / ".aws" / "emulator" / str(self.port)
        self.root.mkdir(parents=True)
        self.put("ca.pem", b"TEST_SYNTHETIC_CA_ONLY")
        self.put("config", f"[default]\nregion = us-east-1\nendpoint_url = https://127.0.0.1:{self.port}\n"
             "ca_bundle = /inside/container/ca.pem\n")
        self.put("emulator_credentials", ("[default]\naws_access_key_id = EMULATOR123456ABCDEF\n"
             + "aws_secret_access_key = " + "A" * 40 + "\n"))
        self.digest = hashlib.sha256((self.root / "ca.pem").read_bytes()).hexdigest()

    def put(self, filename, value):
        file = self.root / filename
        file.write_bytes(value.encode() if isinstance(value, str) else value)
        if os.name != "nt":
            file.chmod(0o600)

    def run_probe(self, callback=None):
        return target.probe_identity(self.port, self.root, self.digest,
                                     sdk_call=callback or (lambda: ACCOUNT))

    def test_positive_only_fixed_sts_operation_and_expected_local_identity(self):
        report = self.run_probe()
        self.assertEqual(report, {"schemaVersion": 1, "status": "verified",
                          "accountVerified": True, "operation": "sts.GetCallerIdentity",
                          "sdkCallAttempted": True})
        for secret in ("EMULATOR123456ABCDEF", "A" * 40, str(self.root)):
            self.assertNotIn(secret, json.dumps(report))

    def test_wrong_account_or_arn_rejected_even_when_tls_and_files_pass(self):
        for value in [
            {**ACCOUNT, "Account": "123456789012"},
            {**ACCOUNT, "Arn": "arn:aws:iam::000000000000:root"},
            {"Account": "000000000000"},
        ]:
            with self.subTest(reply=value), self.assertRaisesRegex(
                    target.RejectedSession, "unexpected_account"):
                self.run_probe(lambda: value)

    def test_real_aws_style_key_is_rejected_without_invoking_sdk(self):
        self.put("emulator_credentials", "[default]\naws_access_key_id = AKIAAAAAAAAAAAAAAAA\n"
                 + "aws_secret_access_key = " + "Z" * 40 + "\n")
        called = []
        with self.assertRaisesRegex(target.RejectedSession, "emulator_credentials_unrecognized"):
            self.run_probe(lambda: called.append("CALLED"))
        self.assertEqual(called, [])

    def test_symlinks_overly_open_or_stale_files_cannot_load_keys(self):
        (self.root / "emulator_credentials").unlink()
        with self.assertRaisesRegex(target.RejectedSession, "session_file_unavailable"):
            self.run_probe()
        self.put("emulator_credentials", "[default]\naws_access_key_id = EMULATOR123456ABCDEF\n"
                 + "aws_secret_access_key = " + "A" * 40 + "\n")
        if os.name != "nt":
            with patch.object(target.os, "geteuid", return_value=os.geteuid() + 1):
                with self.assertRaisesRegex(target.RejectedSession, "session_file_untrusted"):
                    self.run_probe()
            file = self.root / "emulator_credentials"
            file.chmod(0o644)
            with self.assertRaisesRegex(target.RejectedSession, "session_file_untrusted"):
                self.run_probe()
            file.chmod(0o600)
            file.rename(self.root / "old_credentials")
            file.symlink_to(self.root / "old_credentials")
            with self.assertRaisesRegex(target.RejectedSession, "session_file_untrusted"):
                self.run_probe()
        self.put("ca.pem", b"RESTART_ROTATED_CA")
        with self.assertRaisesRegex(target.RejectedSession, "session_certificate_changed"):
            self.run_probe()

    def test_poisoned_official_config_and_proxy_env_do_not_redirect(self):
        self.put("config", "[default]\nregion = us-east-1\nendpoint_url = https://aws.amazon.com\n")
        with self.assertRaisesRegex(target.RejectedSession, "session_config_mismatch"):
            self.run_probe()
        self.put("config", f"[default]\nregion = us-east-1\nendpoint_url = https://127.0.0.1:{self.port}\n")
        with patch.dict(os.environ, {"AWS_PROFILE": "production",
                                  "AWS_ENDPOINT_URL": "https://aws.amazon.com",
                                  "HTTPS_PROXY": "http://198.51.100.8:8080"}):
            self.assertTrue(self.run_probe()["accountVerified"])

    def test_sdk_client_is_fixed_sts_and_redirect_guard_blocks_cloud(self):
        for requested_url, should_pass in (
            (f"https://127.0.0.1:{self.port}/", True),
            ("https://aws.amazon.com/", False),
        ):
            with self.subTest(target=requested_url):
                issued = []
                class FakeHTTP:
                    def send(self, request):
                        issued.append(request.url)
                        return object()

                class FakeClient:
                    def __init__(self):
                        self._endpoint = SimpleNamespace(http_session=FakeHTTP())
                    def get_caller_identity(self):
                        self._endpoint.http_session.send(SimpleNamespace(url=requested_url))
                        return ACCOUNT

                class FakeSession:
                    def create_client(self, service, **kwargs):
                        self._check(service, kwargs)
                        return FakeClient()
                    def _check(self, service, kwargs):
                        self_test.assertEqual(service, 'sts')
                        self_test.assertEqual(kwargs['endpoint_url'],
                                              f'https://127.0.0.1:{self_test.port}')
                        self_test.assertEqual(kwargs['region_name'], 'us-east-1')
                        self_test.assertTrue(kwargs['aws_access_key_id'].startswith('EMULATOR'))
                        self_test.assertTrue(kwargs['verify'].endswith('ca.pem'))

                self_test = self
                package = ModuleType('botocore')
                package.__path__ = []
                config = ModuleType('botocore.config')
                config.Config = lambda **kwargs: kwargs
                session = ModuleType('botocore.session')
                session.get_session = lambda: FakeSession()
                with patch.dict(sys.modules, {'botocore': package,
                                              'botocore.config': config,
                                              'botocore.session': session}):
                    if should_pass:
                        self.assertTrue(target.probe_identity(self.port,self.root,self.digest)['accountVerified'])
                        self.assertEqual(issued, [requested_url])
                    else:
                        with self.assertRaisesRegex(target.RejectedSession,
                                                    'network_target_blocked'):
                            target.probe_identity(self.port,self.root,self.digest)
                        self.assertEqual(issued, [])

    def test_network_guard_blocks_non_loopback_and_port_collision(self):
        # No real sockets are connected in this test.
        with target.loopback_guard(self.port):
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                for address in [
                    ("198.51.100.8", 443), ("127.0.0.1", self.port + 1),
                    ("localhost", self.port), ("::1", self.port),
                ]:
                    with self.subTest(address=address), self.assertRaisesRegex(
                            target.RejectedSession, "network_target_blocked"):
                        sock.connect(address)
                with self.assertRaisesRegex(target.RejectedSession, "network_target_blocked"):
                    socket.getaddrinfo("aws.amazon.com", 443)
            finally:
                sock.close()
        self.assertIsNot(socket.socket.connect, None)


if __name__ == "__main__":
    unittest.main()
