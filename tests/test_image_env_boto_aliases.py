"""Inert credential-provider alias regression; separate from Agent D's Windows test edits."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_image_env_keys.py"
sys.path.insert(0, str(ROOT / "scripts"))
from check_image_env_keys import UnsafeImageEnvironment, verify_env_keys

MARKER = "AWS_EMULATOR_MCP_ISOLATED_LAB=1"
SENTINEL = "FAKE_CREDENTIAL_VALUE_DO_NOT_ECHO"


class ImageBotoAliasSecurityTests(unittest.TestCase):
    def run_scan(self, entries):
        return subprocess.run([sys.executable, "-B", str(SCRIPT)],
                              input=json.dumps(entries).encode("utf8"),
                              capture_output=True, timeout=8)

    def test_boto_config_path_and_case_variants_are_rejected_without_values(self):
        # BOTO_CONFIG is consumed by Botocore's Boto2Config provider.
        # BOTO_PATH is a historical Boto configuration path alias.
        for name in ("BOTO_CONFIG", "BOTO_PATH", "boto_config", "boto_path",
                     "BoTo_CoNfIg", "bOtO_pAtH", "BOTO_UNKNOWN_CREDENTIAL_SOURCE"):
            with self.subTest(name=name):
                entries = ["PATH=/usr/bin", MARKER, name + "=" + SENTINEL]
                with self.assertRaises(UnsafeImageEnvironment):
                    verify_env_keys(json.dumps(entries).encode("utf8"))
                outcome = self.run_scan(entries)
                self.assertEqual(outcome.returncode, 1)
                self.assertEqual(outcome.stdout, b"")
                self.assertEqual(outcome.stderr.splitlines(),
                                 [b"DOCKER_IMAGE_ENV_KEYS_GATE_FAILED"])
                self.assertNotIn(SENTINEL.encode(), outcome.stdout + outcome.stderr)
                self.assertNotIn(name.encode(), outcome.stdout + outcome.stderr)

    def test_no_boto_exemption_may_bypass_fixed_aws_emulator_allowlist(self):
        ok = self.run_scan(["PATH=/bin", MARKER, "AWS_EMULATOR_PORT=9297"])
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertEqual(ok.stderr, b"")
        self.assertEqual(ok.stdout.splitlines(), [
            b"DOCKER_IMAGE_CREDENTIAL_ENV_KEYS_ABSENT",
            b"DOCKER_IMAGE_ISOLATED_MARKER_PRESENT",
        ])
        for unsafe in ("aws_secret_access_key", "aWs_SeCrEt_AcCeSs_KeY",
                       "AmAzOn_SeCrEt_AcCeSs_KeY", "aws_emulator_port"):
            with self.subTest(name=unsafe):
                outcome = self.run_scan([MARKER, unsafe + "=" + SENTINEL])
                self.assertEqual(outcome.returncode, 1)
                self.assertEqual(outcome.stdout, b"")
                self.assertEqual(outcome.stderr.splitlines(),
                                 [b"DOCKER_IMAGE_ENV_KEYS_GATE_FAILED"])
                self.assertNotIn(SENTINEL.encode(), outcome.stderr)


if __name__ == "__main__":
    unittest.main()
