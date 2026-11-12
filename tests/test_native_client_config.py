"""Safe client setup and current VS Code Copilot schema regression tests."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
from connect_client import merge,ConfigError,read_object,NAME
from generate_client_config import render

class NativeCopilotTests(unittest.TestCase):
    def make_source(self,path,root="/mnt/c/Users/Test/CodeGym/v0.3.0"):
        payload={"mcpServers":{NAME:{
            "type":"stdio","command":"wsl.exe",
            "args":["-e","bash",root+"/scripts/serve_wsl.sh"]}}}
        path.write_text(json.dumps(payload))
        return path

    def test_generator_emits_native_and_legacy_schemas(self):
        platforms=("linux",) if sys.platform=="win32" else ("windows-wsl","linux")
        for platform in platforms:
            result=render(ROOT,platform)
            self.assertIn("copilot",result)
            self.assertIn("mcpServers",result["copilot"])
            self.assertIn(NAME,result["copilot"]["mcpServers"])
            self.assertIn("servers",result["vscode"])
            self.assertIn(NAME,result["vscode"]["servers"])
            self.assertIn(NAME,result["mcp"]["mcpServers"])
            command = "wsl.exe" if platform=="windows-wsl" else "bash"
            self.assertEqual(result["copilot"]["mcpServers"][NAME]["command"],command)

    def test_preview_is_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);src=self.make_source(root/"generated.json");dst=root/"mcp-config.json"
            result=merge(src,dst)
            self.assertEqual(result["status"],"preview")
            self.assertFalse(dst.exists())

    def test_idempotent_merge_preserves_other_servers(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);src=self.make_source(root/"generated.json");dst=root/"mcp-config.json"
            old={"mcpServers":{"existing-safe-server":{"command":"node","args":["server.js"]}},
                 "settings":{"other":12}}
            dst.write_text(json.dumps(old))
            first=merge(src,dst,apply=True)
            self.assertTrue(first["changed"])
            self.assertTrue(Path(first["backup"]).is_file())
            new=read_object(dst)
            self.assertEqual(new["mcpServers"]["existing-safe-server"],old["mcpServers"]["existing-safe-server"])
            self.assertEqual(new["settings"],old["settings"])
            again=merge(src,dst,apply=True)
            self.assertFalse(again["changed"])
            self.assertEqual(again["status"],"already_configured")

    def test_conflicts_refuse_without_opt_in_replace(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);src=self.make_source(root/"generated.json");dst=root/"target.json"
            dst.write_text(json.dumps({"mcpServers":{NAME:{"command":"other.exe"}}}))
            with self.assertRaisesRegex(ConfigError,"Conflicting"):
                merge(src,dst,apply=True)
            result=merge(src,dst,apply=True,replace_existing=True)
            self.assertTrue(result["changed"])
            self.assertEqual(read_object(dst)["mcpServers"][NAME]["command"],"wsl.exe")

    def test_invalid_json_refuses_without_write(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);src=self.make_source(root/"generated.json");dst=root/"target.json"
            original='{"mcpServers":{"one": 1, "one": 2}}'
            dst.write_text(original)
            with self.assertRaisesRegex(ConfigError,"Duplicate"):
                merge(src,dst,apply=True)
            self.assertEqual(dst.read_text(),original)

    def test_malicious_generated_launcher_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);src=self.make_source(root/"generated.json");dst=root/"target.json"
            bad={"mcpServers":{NAME:{"command":"powershell.exe","args":["-EncodedCommand","malicious"]}}}
            src.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ConfigError,"unexpected command"):
                merge(src,dst,apply=True)
            self.assertFalse(dst.exists())

    def test_existing_symlink_destination_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);src=self.make_source(root/"generated.json")
            victim=root/"victim.json";victim.write_text("{}")
            link=root/"config.json"
            try:link.symlink_to(victim)
            except (OSError,NotImplementedError):
                self.skipTest("Symlinks unsupported on this runner")
            with self.assertRaisesRegex(ConfigError,"symlink"):
                merge(src,link,apply=True)
            self.assertEqual(victim.read_text(),"{}")

if __name__=="__main__":
    unittest.main()
