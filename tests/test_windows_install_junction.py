"""Windows installer must not follow junctions into unrelated user files."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]

@unittest.skipUnless(sys.platform=="win32","Windows junction safety test")
class InstallerJunctionTests(unittest.TestCase):
    def test_managed_install_junction_is_refused_before_mutation(self):
        with tempfile.TemporaryDirectory(prefix="codegym-installer-junction-") as tmp:
            base=Path(tmp)
            target=base/"CodeGym"/"AWS-Emulator-MCP"
            target.parent.mkdir(parents=True)
            victim=base/"do-not-touch"
            victim.mkdir()
            sentinel=victim/"keep.txt"
            sentinel.write_text("preserve")
            quote=lambda value: "'"+str(value).replace("'","''")+"'"
            command="New-Item -ItemType Junction -Path "+quote(target)+" -Target "+quote(victim)+" -ErrorAction Stop | Out-Null"
            created=subprocess.run(["powershell.exe","-NoProfile","-Command",command],
                                   capture_output=True,text=True,timeout=40)
            if created.returncode:
                self.skipTest("Junction creation unavailable in this Windows runner")
            env=dict(os.environ,LOCALAPPDATA=tmp)
            result=subprocess.run(["powershell.exe","-NoProfile","-ExecutionPolicy",
                                   "Bypass","-File",str(ROOT/"install.ps1")],
                                  capture_output=True,text=True,env=env,timeout=45)
            self.assertNotEqual(result.returncode,0)
            self.assertIn("Refusing linked installation directory",result.stdout+result.stderr)
            self.assertEqual(sentinel.read_text(),"preserve")
            self.assertFalse((victim/"v0.3.0").exists())

    def test_nested_junction_in_existing_managed_target_is_refused(self):
        with tempfile.TemporaryDirectory(prefix="codegym-nested-junction-") as tmp:
            base=Path(tmp)
            source_dir=base/"CodeGym"/"AWS-Emulator-MCP"/"v0.3.0"/"src"
            source_dir.mkdir(parents=True)
            victim=base/"keep-me"
            victim.mkdir()
            sentinel=victim/"keep.txt"
            sentinel.write_text("untouched")
            junction=source_dir/"linked"
            quote=lambda value: "'"+str(value).replace("'","''")+"'"
            command="New-Item -ItemType Junction -Path "+quote(junction)+" -Target "+quote(victim)+" -ErrorAction Stop | Out-Null"
            created=subprocess.run(["powershell.exe","-NoProfile","-Command",command],
                                   capture_output=True,text=True,timeout=40)
            if created.returncode:
                self.skipTest("Junction creation unavailable in this Windows runner")
            env=dict(os.environ,LOCALAPPDATA=tmp)
            result=subprocess.run(["powershell.exe","-NoProfile","-ExecutionPolicy",
                                   "Bypass","-File",str(ROOT/"install.ps1")],
                                  capture_output=True,text=True,env=env,timeout=45)
            self.assertNotEqual(result.returncode,0)
            self.assertIn("Refusing linked content inside managed target entry",result.stdout+result.stderr)
            self.assertEqual(sentinel.read_text(),"untouched")

if __name__=="__main__":
    unittest.main()
