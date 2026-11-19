"""Inert CI prebuilt-image gate regressions: no Docker, AWS or app execution."""
from pathlib import Path
import json
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
import docker_bundle_smoke as smoke


def ready_report():
    return {'schemaVersion': 1, 'emulatorReady': True,
            'imageCached': True, 'imageReusable': True,
            'imageSourceStatus': 'matched',
            'imageBuildSpace': {'buildExpected': False, 'status': 'not_needed'},
            'checks': {'node': {'passed': True}, 'docker': {'passed': True},
                       'image': {'passed': True}}}


def completed(report, returncode=0):
    return SimpleNamespace(returncode=returncode,
                           stdout=json.dumps(report), stderr='')


class DockerBundleCiGateTests(unittest.TestCase):
    def test_matched_prebuilt_allows_doctor_only_after_read_only_preflight(self):
        calls = []
        class HaltBeforeDocker(Exception):
            pass
        def synthetic(command, **kwargs):
            calls.append(command)
            if command == 'preflight':
                self.assertEqual(kwargs['json_mode'], True)
                self.assertLessEqual(kwargs['timeout'], 30)
                return completed(ready_report())
            if command == 'doctor':
                raise HaltBeforeDocker()
            self.fail('Unexpected command: ' + command)
        with patch.object(smoke, 'run', side_effect=synthetic):
            with self.assertRaises(HaltBeforeDocker):
                smoke.verify()
        self.assertEqual(calls, ['preflight', 'doctor'])

    def test_missing_mismatched_or_unverified_image_never_reaches_doctor(self):
        modifications = [
            lambda x: x.update(imageCached=False),
            lambda x: x.update(imageSourceStatus='mismatched'),
            lambda x: x.update(imageSourceStatus='unverified'),
            lambda x: x.update(imageReusable=False),
            lambda x: x['imageBuildSpace'].update(buildExpected=True),
            lambda x: x['checks']['image'].update(passed=False),
            lambda x: x['checks']['docker'].update(passed=False),
            lambda x: x.update(emulatorReady=False),
        ]
        for mutate in modifications:
            report = ready_report()
            mutate(report)
            commands = []
            def synthetic(command, **kwargs):
                commands.append(command)
                if command != 'preflight':
                    self.fail('Unexpected post-failure command')
                return completed(report)
            with self.subTest(report=report), patch.object(smoke, 'run', side_effect=synthetic):
                with self.assertRaises(smoke.PrebuiltImageRequired):
                    smoke.verify()
                self.assertEqual(commands, ['preflight'])

    def test_malformed_json_timeout_and_fail_status_have_redacted_reasons(self):
        private_path = '/home/customer/private/key.txt'
        scenarios = [
            (SimpleNamespace(returncode=0, stdout='{'+private_path, stderr=private_path),
             'DOCKER_SMOKE_PREFLIGHT_INVALID_JSON'),
            (completed(ready_report(), returncode=1),
             'DOCKER_SMOKE_LOCAL_PREFLIGHT_NOT_READY'),
            (subprocess.TimeoutExpired(['node', private_path], 30),
             'DOCKER_SMOKE_PREFLIGHT_UNAVAILABLE'),
        ]
        for synthetic_result, expected in scenarios:
            def synthetic(*args, **kwargs):
                if isinstance(synthetic_result, BaseException):
                    raise synthetic_result
                return synthetic_result
            with self.subTest(expected=expected):
                with self.assertRaises(smoke.PrebuiltImageRequired) as raised:
                    smoke.require_prebuilt_image(synthetic)
                self.assertEqual(str(raised.exception), expected)
                self.assertNotIn(private_path, str(raised.exception))

    def test_every_smoke_subprocess_sets_prebuilt_only_env(self):
        with patch.object(smoke.subprocess, 'run', return_value=completed({})) as mocked:
            smoke.run('doctor', json_mode=True)
            self.assertEqual(mocked.call_args.args[0][2], 'doctor')
            self.assertEqual(mocked.call_args.kwargs['timeout'], 300)
            self.assertEqual(mocked.call_args.kwargs['env']['AWS_EMULATOR_MCP_QA_REQUIRE_PREBUILT'], '1')

    def test_explicit_signed_build_and_preflight_before_full_smoke(self):
        text = (ROOT / '.github/workflows/tests.yml').read_text(encoding='utf8')
        section = text.split('  docker-bundle-live:\n', 1)[1].split('  live-official-aws:\n', 1)[0]
        names = [
            'Install the packed npm package in isolation',
            'Check Docker runner and signed-image disk advisory before explicit build',
            'Explicitly build the signed official emulator image from the packed CLI',
            'Verify packed CLI read-only preflight matches the explicitly built image',
            'No AWS credential env keys in built image',
            'Run real Docker MCP demos, SDK API assertions and scoped cleanup from prebuilt image',
            'Publish actual read-only coverage results in the CI summary',
            'Compare current API smoke results against last published baseline',
        ]
        positions = [section.index('- name: ' + name) for name in names]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(section.count('python3 tests/docker_bundle_smoke.py'), 1)
        self.assertIn('node .qa-npm/node_modules/aws-emulator-mcp/bin/aws-emulator-mcp.mjs build', section)
        self.assertIn("AWS_EMULATOR_MCP_QA_REQUIRE_PREBUILT: '1'", section)
        self.assertIn('DOCKER_PREBUILD_DISK_ADVISORY', section)
        self.assertIn('imageSourceStatus', section)
        self.assertIn('imageReusable', section)
        self.assertIn('imageCached', section)
        self.assertIn('hostWorkspaceDisk', section)
        self.assertIn('hostVisibleDockerRootDisk', section)
        self.assertIn('coverage --json', section)
        self.assertIn('coverage-diff', section)
        self.assertIn('DOCKER_SOURCE_IDENTITY_PASS', section)
        self.assertIn('aws-emulator-mcp:0.4.0-beta.15', section)
        self.assertNotIn('docker system prune', section)
        self.assertNotIn('--skip-real', section)
        # The first preflight intentionally exits 1 when no image exists. It
        # must NOT make the explicit build step unreachable under bash -e.
        self.assertIn('test "$?" -eq 1 || exit 1', section)
        self.assertIn("assert report['checks']['docker']['passed'] is True", section)

    def test_bounded_hosted_job_and_distinct_signed_build_and_smoke_timeouts(self):
        text = (ROOT / '.github/workflows/tests.yml').read_text()
        section = text.split('  docker-bundle-live:\n', 1)[1].split('  live-official-aws:\n', 1)[0]
        self.assertIn('    timeout-minutes: 45\n', section)
        for name, timeout in (
            ('Check Docker runner and signed-image disk advisory before explicit build', 2),
            ('Explicitly build the signed official emulator image from the packed CLI', 15),
            ('Verify packed CLI read-only preflight matches the explicitly built image', 3),
            ('No AWS credential env keys in built image', 1),
            ('Run real Docker MCP demos, SDK API assertions and scoped cleanup from prebuilt image', 20),
        ):
            sub = section.split('      - name: ' + name + '\n', 1)[1]
            self.assertTrue(sub.startswith('        timeout-minutes: ' + str(timeout) + '\n'), name)

    def test_credential_gate_reads_image_config_env_without_printing_values(self):
        text = (ROOT / '.github/workflows/tests.yml').read_text()
        section = text.split('  docker-bundle-live:\n', 1)[1].split('  live-official-aws:\n', 1)[0]
        self.assertIn("--format '{{json .Config.Env}}' | python3 scripts/check_image_env_keys.py", section)
        self.assertIn('AWS_EMULATOR_MCP_ISOLATED_LAB=1', section)
        self.assertNotIn('docker run --rm --network none --entrypoint env', section)
        self.assertNotIn('Verify no production credentials are available to the image', section)
        self.assertIn('No AWS credential env keys in built image', section)
