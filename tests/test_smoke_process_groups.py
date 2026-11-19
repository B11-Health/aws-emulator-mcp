"""Linux-only inert child-process tests for Docker CI smoke's bounded cleanup.

The synthetic 'node' here is Python. Never invokes Node, Docker, AWS or network.
Each subprocess is owned; the test kills any live leftover in finally.
"""
import errno
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_bundle_smoke as smoke

SENSITIVE = 'SYNTHETIC_SECRET_NEVER_LOG_FROM_SMOKE_CHILD'


def process_active(pid):
    """Linux /proc shows zombies as dead; they cannot execute or hold FDs."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    status = Path('/proc') / str(pid) / 'stat'
    try:
        # Parse after the parenthesized executable name, which may have spaces.
        state = status.read_text().rsplit(')', 1)[-1].strip().split()[0]
        return state not in ('Z', 'X')
    except (FileNotFoundError, ProcessLookupError):
        # The process can exit after kill(pid, 0), including during stat.read().
        # Linux may report either ENOENT or ESRCH for this disappearance race.
        return False


class ProcessActiveProbeTests(unittest.TestCase):
    """Deterministic probe races; no real process, signal, or /proc access."""

    def test_missing_kill_probe_does_not_read_stat(self):
        with patch.object(os, 'kill', side_effect=ProcessLookupError(errno.ESRCH, 'exited')), \
                patch.object(Path, 'read_text') as read_stat:
            self.assertFalse(process_active(17777))
            read_stat.assert_not_called()

    def test_disappearing_stat_is_inactive(self):
        for error in (FileNotFoundError(errno.ENOENT, 'exited'),
                      ProcessLookupError(errno.ESRCH, 'exited')):
            with self.subTest(error=type(error).__name__), \
                    patch.object(os, 'kill', return_value=None) as probe, \
                    patch.object(Path, 'read_text', side_effect=error) as read_stat:
                self.assertFalse(process_active(17777))
                probe.assert_called_once_with(17777, 0)
                read_stat.assert_called_once_with()

    def test_alive_and_exited_process_states(self):
        for state, expected in [('R', True), ('S', True), ('Z', False), ('X', False)]:
            with self.subTest(state=state), \
                    patch.object(os, 'kill', return_value=None), \
                    patch.object(Path, 'read_text', return_value=f'17777 (synthetic (child) name) {state} 1 2'):
                self.assertEqual(process_active(17777), expected)

    def test_unrelated_probe_and_stat_errors_are_not_absence(self):
        for stage in ('probe', 'stat'):
            for error in (PermissionError(errno.EACCES, 'denied'),
                          OSError(errno.EIO, 'synthetic I/O error')):
                with self.subTest(stage=stage, error=type(error).__name__), \
                        patch.object(os, 'kill', side_effect=error if stage == 'probe' else None), \
                        patch.object(Path, 'read_text', side_effect=error if stage == 'stat' else None):
                    with self.assertRaises(type(error)) as raised:
                        process_active(17777)
                    self.assertIs(raised.exception, error)


@unittest.skipUnless(sys.platform == 'linux', 'Hosted Docker bundle runs on Linux')
class SmokeProcessGroupTests(unittest.TestCase):
    def exercise(self, mode):
        with tempfile.TemporaryDirectory(prefix='synthetic-smoke-owned-process-') as folder:
            path = Path(folder)
            fake = path / 'node'
            recorded = path / 'child.pid'
            fake.write_text('#!/usr/bin/env python3\n' + r'''
import os
from pathlib import Path
import subprocess
import sys
import time

mode = os.environ['SYNTHETIC_CLI_MODE']
child = subprocess.Popen([sys.executable, '-c',
    'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)'
    if mode == 'ignore-term' else 'import time; time.sleep(30)'],
    stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
Path(os.environ['SYNTHETIC_CHILD_PIDFILE']).write_text(str(child.pid))
print('SYNTHETIC_SECRET_NEVER_LOG_FROM_SMOKE_CHILD', flush=True)
if mode == 'nonzero':
    sys.exit(7)
time.sleep(30)
''', encoding='utf8')
            fake.chmod(0o755)
            env = {'PATH': str(path) + os.pathsep + os.environ.get('PATH', ''),
                   'SYNTHETIC_CHILD_PIDFILE': str(recorded),
                   'SYNTHETIC_CLI_MODE': mode}
            pid = None
            start = time.monotonic()
            try:
                with patch.dict(os.environ, env):
                    if mode == 'nonzero':
                        result = smoke.run('doctor', json_mode=True, timeout=2)
                        self.assertEqual(result.returncode, 7)
                        self.assertEqual(result.stdout.strip(), SENSITIVE)
                    else:
                        with self.assertRaises(subprocess.TimeoutExpired) as captured:
                            smoke.run('doctor', json_mode=True, timeout=1.2)
                        self.assertNotIn(SENSITIVE, str(captured.exception))
                        self.assertNotIn(str(path), str(captured.exception))
                        self.assertFalse(captured.exception.stdout)
                self.assertLess(time.monotonic() - start, 9,
                                'Cleanup must remain bounded, including SIGKILL escalation')
                self.assertTrue(recorded.exists(), 'Synthetic child was not spawned')
                pid = int(recorded.read_text())
                for _ in range(30):
                    if not process_active(pid):
                        break
                    time.sleep(0.05)
                self.assertFalse(process_active(pid),
                                 'Fake child must not survive subprocess timeout or error')
            finally:
                if pid is None and recorded.exists():
                    pid = int(recorded.read_text())
                if pid is not None and process_active(pid):
                    os.kill(pid, signal.SIGKILL)

    def test_timeout_kills_parent_and_normal_child(self):
        self.exercise('timeout')

    def test_timeout_escalates_for_child_ignoring_sigterm(self):
        self.exercise('ignore-term')

    def test_nonzero_exit_cleans_owned_descendant(self):
        self.exercise('nonzero')

    def test_wrapper_sigterm_cleans_descendants_before_exit(self):
        """Simulate a hosted step cancellation; no real Node or Docker."""
        with tempfile.TemporaryDirectory(prefix='synthetic-smoke-step-cancel-') as folder:
            location = Path(folder)
            fake_node = location / 'node'
            child_pid_file = location / 'cancel-child.pid'
            fake_node.write_text('#!/usr/bin/env python3\n' + r'''
import os
from pathlib import Path
import subprocess
import sys
import time
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],
    stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
Path(os.environ['SYNTHETIC_CHILD_PIDFILE']).write_text(str(child.pid))
print('SYNTHETIC_SECRET_NEVER_LOG_FROM_SMOKE_CHILD',flush=True)
time.sleep(30)
''', encoding='utf8')
            fake_node.chmod(0o755)
            env = dict(os.environ,
                       PATH=str(location) + os.pathsep + os.environ.get('PATH', ''),
                       SYNTHETIC_CHILD_PIDFILE=str(child_pid_file))
            run_code = (
                "import sys; "
                "sys.path.insert(0, " + repr(str(Path(__file__).resolve().parent)) + "); "
                "import docker_bundle_smoke as smoke; "
                "smoke.run('doctor', json_mode=True, timeout=30)"
            )
            wrapper = subprocess.Popen([sys.executable, '-c', run_code],
                                       env=env, cwd=smoke.ROOT,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       text=True, start_new_session=True)
            child_pid = None
            try:
                for _ in range(100):
                    if child_pid_file.exists():
                        break
                    if wrapper.poll() is not None:
                        break
                    time.sleep(0.04)
                self.assertTrue(child_pid_file.exists(), 'Synthetic CLI child never started')
                child_pid = int(child_pid_file.read_text())
                self.assertTrue(process_active(child_pid))
                os.kill(wrapper.pid, signal.SIGTERM)
                stdout, stderr = wrapper.communicate(timeout=9)
                self.assertNotEqual(wrapper.returncode, 0)
                self.assertNotIn(SENSITIVE, stdout + stderr)
                for _ in range(30):
                    if not process_active(child_pid):
                        break
                    time.sleep(0.05)
                self.assertFalse(process_active(child_pid),
                                 'External SIGTERM must not orphan the CLI descendant')
            finally:
                if wrapper.poll() is None:
                    try:
                        os.killpg(wrapper.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    wrapper.communicate(timeout=3)
                if child_pid is None and child_pid_file.exists():
                    child_pid = int(child_pid_file.read_text())
                if child_pid is not None and process_active(child_pid):
                    os.kill(child_pid, signal.SIGKILL)
