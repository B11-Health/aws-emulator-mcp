"""Offline X.509 proof: trusting an emulator-shaped CA != trusting a DNS name.

Synthetic temporary, localhost-SAN self-signed certificates only. Never
starts Docker, opens a socket, calls AWS, reads credentials, or publishes keys.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
GUIDE = ROOT / "docs" / "TESTCONTAINERS_FIRST_RUN.md"
OPENSSL = shutil.which("openssl")


@unittest.skipUnless(OPENSSL, "OpenSSL is needed for the offline X.509 example")
class TestcontainersCertificateIdentity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="synthetic-localhost-san-")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.cert, self.key = self.make_synthetic_certificate("first")

    def command(self, arguments, timeout=12):
        return subprocess.run([OPENSSL, *arguments], capture_output=True,
                              text=True, check=False, timeout=timeout)

    def make_synthetic_certificate(self, stem):
        cert = self.work / (stem + ".pem")
        key = self.work / (stem + ".key")
        result = self.command([
            "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
            "-days", "1", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-keyout", str(key), "-out", str(cert),
        ], timeout=20)
        # Do not echo OpenSSL output: a failure could include a local path.
        self.assertEqual(result.returncode, 0, "Synthetic certificate generation failed")
        self.assertTrue(cert.is_file())
        self.assertTrue(key.is_file())
        return cert, key

    def verify(self, ca, cert, identity=()):
        return self.command(["verify", "-CAfile", str(ca), *identity, str(cert)])

    def test_trusted_ca_does_not_authorize_a_missing_docker_dns_san(self):
        # Prove the certificate chain is trusted with the exact same CA that
        # will be used in the failed DNS identity verification.
        trust = self.verify(self.cert, self.cert)
        self.assertEqual(trust.returncode, 0, "Synthetic CA trust unexpectedly failed")
        self.assertIn("OK", trust.stdout)
        for name in ("aws", "aws-emulator", "emulator.local"):
            with self.subTest(host=name):
                result = self.verify(self.cert, self.cert, ("-verify_hostname", name))
                self.assertNotEqual(result.returncode, 0, "Missing DNS SAN unexpectedly accepted")
                self.assertIn("hostname mismatch", result.stderr.lower())

    def test_loopback_sans_match_only_the_identity_requested(self):
        for args in (("-verify_hostname", "localhost"),
                     ("-verify_ip", "127.0.0.1"),
                     ("-verify_ip", "::1")):
            with self.subTest(identity=args):
                result = self.verify(self.cert, self.cert, args)
                self.assertEqual(result.returncode, 0, "Expected loopback SAN rejected")
                self.assertIn("OK", result.stdout)
        # 127.0.0.1 belongs to whichever network namespace the client runs in;
        # this crypto result cannot make a sibling container reach the server.

    def test_new_run_certificate_requires_updated_trust_even_for_localhost(self):
        second, _ = self.make_synthetic_certificate("second")
        trust_new = self.verify(second, second, ("-verify_hostname", "localhost"))
        self.assertEqual(trust_new.returncode, 0)
        stale_trust = self.verify(self.cert, second, ("-verify_hostname", "localhost"))
        self.assertNotEqual(stale_trust.returncode, 0,
                            "An unrelated old run's CA must not verify a new run")


class TestcontainersFirstRunDoc(unittest.TestCase):
    def test_boundary_and_safe_first_run_paths_are_explicit(self):
        doc = GUIDE.read_text(encoding="utf8")
        for term in (
            "host-run Testcontainers", "separate test container",
            "127.0.0.1", "https://aws:9297", "hostname verification",
            "CA", "SAN", "emulator_credentials", "ca.pem", "truststore.p12",
            "localhost-only", "fresh", "SIGV4", "no ports", "--network none",
            "python3 -m unittest", "aws/aws-emulator/issues/23",
            "aws/aws-emulator/issues/566", "not an emulator integration test",
        ):
            self.assertIn(term.lower(), doc.lower(), term)
        self.assertNotIn("docker run -p 9297:9297", doc)
        self.assertNotIn("curl -k ", doc)
        self.assertNotIn("verify=False", doc)
        self.assertNotIn("--insecure https://", doc)
        self.assertNotIn("auth off", doc.lower())
        self.assertNotIn("SYNTHETIC_LOCALHOST_PRIVATE_KEY", doc)


if __name__ == "__main__":
    unittest.main()
