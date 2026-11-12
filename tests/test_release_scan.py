"""Pre-release credential and version consistency scanner tests."""
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from release_scan import KEY_PATTERNS, ROOT, git_files

class ReleaseScanTests(unittest.TestCase):
    def test_detects_constructed_fake_access_key(self):
        fake="AKIA"+("A"*16)
        self.assertTrue(KEY_PATTERNS["AWS_ACCESS_KEY"].search(fake))

    def test_short_placeholder_is_not_a_credential(self):
        self.assertFalse(KEY_PATTERNS["AWS_ACCESS_KEY"].search("AKIAEXAMPLE"))

    def test_detects_constructed_private_key_header(self):
        header="-----BEGIN "+"RSA PRIVATE KEY-----"
        self.assertTrue(KEY_PATTERNS["PRIVATE_KEY"].search(header))

    def test_git_files_include_source_not_generated_reports(self):
        names={str(p.relative_to(ROOT)).replace("\\","/") for p in git_files()}
        self.assertIn("src/aws_emulator_mcp/server.py",names)
        self.assertNotIn("reports/gtm_latest.json",names)

if __name__=="__main__":
    unittest.main()
