"""Inert image ENV-name tests. Never call Docker or print any supplied values."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from check_image_env_keys import UnsafeImageEnvironment, verify_env_keys

SCRIPT = ROOT / 'scripts/check_image_env_keys.py'
MARKER = 'AWS_EMULATOR_MCP_ISOLATED_LAB=1'
SECRET = 'PRIVATE_SYNTHETIC_SECRET_MUST_NOT_APPEAR_IN_OUTPUT'


class ImageEnvKeyGateTests(unittest.TestCase):
    def inspect_inert(self, entries):
        return subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(entries),
                              text=True, capture_output=True, timeout=10)

    def test_safe_image_env_and_isolation_marker_pass_without_echoing_values(self):
        result = self.inspect_inert(['PATH='+SECRET, MARKER,
                                     'AWS_EMULATOR_PORT=9297', 'PYTHONPATH=/opt/synthetic'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout,
                         'DOCKER_IMAGE_CREDENTIAL_ENV_KEYS_ABSENT\n'
                         'DOCKER_IMAGE_ISOLATED_MARKER_PRESENT\n')
        self.assertEqual(result.stderr, '')
        self.assertNotIn(SECRET, result.stdout)

    def test_all_aws_credential_provider_aliases_are_rejected_without_leaks(self):
        keys = ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
                'AWS_WEB_IDENTITY_TOKEN_FILE', 'AWS_PROFILE',
                'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE',
                'AWS_CONTAINER_CREDENTIALS_FULL_URI',
                'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
                'AWS_ROLE_ARN', 'AWS_ROLE_SESSION_NAME',
                'AWS_CREDENTIAL_FILE', 'AWS_SECURITY_TOKEN',
                'AMAZON_ACCESS_KEY_ID', 'amazon_secret_access_key',
                'Aws_Secret_Access_Key', 'aWs_pRoFiLe', 'AWS_ENDPOINT_URL')
        for key in keys:
            with self.subTest(key=key):
                result = self.inspect_inert(['PATH=/bin', MARKER, key+'='+SECRET])
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, 'DOCKER_IMAGE_ENV_KEYS_GATE_FAILED\n')
                self.assertNotIn(SECRET, result.stderr)
                self.assertNotIn(key, result.stderr)

    def test_missing_marker_wrong_value_and_case_insensitive_duplicate_fail_closed(self):
        cases = [
            ['PATH=/bin'],
            ['PATH=/bin', 'AWS_EMULATOR_MCP_ISOLATED_LAB=0'],
            [MARKER, 'aws_emulator_mcp_isolated_lab=1'],
            ['aws_emulator_mcp_isolated_lab=1'],
            [MARKER, 'aws_emulator_port=9297'],
            [MARKER, 'AWS_EMULATOR_PORT=9297', 'aws_emulator_port=9298'],
            [MARKER, 'BAD-NAME='+SECRET],
            [MARKER, 'AWS_EMULATOR_PORT'],
        ]
        for entries in cases:
            with self.subTest(entries_count=len(entries)):
                result = self.inspect_inert(entries)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertEqual(result.stderr, 'DOCKER_IMAGE_ENV_KEYS_GATE_FAILED\n')
                self.assertNotIn(SECRET, result.stderr)

    def test_malformed_or_oversized_input_fails_with_constant_error_only(self):
        for data in (b'{'+SECRET.encode(), b'null', b'{}', b'[]',
                     b'"'+SECRET.encode()+b'"', b'X'*65537):
            with self.subTest(size=len(data)):
                with self.assertRaises(UnsafeImageEnvironment):
                    verify_env_keys(data)
                outcome = subprocess.run([sys.executable, str(SCRIPT)], input=data,
                                         capture_output=True, timeout=10)
                self.assertEqual(outcome.returncode, 1)
                self.assertEqual(outcome.stdout, b'')
                self.assertEqual(outcome.stderr, b'DOCKER_IMAGE_ENV_KEYS_GATE_FAILED\n')


if __name__ == '__main__':
    unittest.main()
