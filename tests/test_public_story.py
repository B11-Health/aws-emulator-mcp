"""Keep our public-facing promises compatible with shipped commands and files."""
from pathlib import Path
import re
import unittest

ROOT=Path(__file__).resolve().parents[1]
PAGES=("README.md","docs/WHAT_YOU_CAN_BUILD.md","docs/LAUNCH_DEMO.md",
       "docs/linkedin-draft.md")

class ProductStoryTests(unittest.TestCase):
    def test_internal_markdown_links_resolve(self):
        for source in PAGES:
            page=ROOT/source
            text=page.read_text(encoding="utf-8")
            for target in re.findall(r"(?<!!)\[[^]]+\]\(([^)]+)\)",text):
                if target.startswith(("https://","http://","mailto:","#")):
                    continue
                path=target.split("#",1)[0]
                if not path:
                    continue
                with self.subTest(source=source,link=target):
                    self.assertTrue((page.parent/path).exists(),f"{source} -> {target}")

    def test_readme_starts_with_value_not_tool_versions(self):
        lead=(ROOT/"README.md").read_text(encoding="utf-8")[:1600]
        self.assertIn("Your AWS playground",lead)
        self.assertIn("No AWS account",lead)
        self.assertIn("S3",lead)
        self.assertIn("DynamoDB",lead)
        self.assertIn("SQS",lead)

    def test_no_remote_write_claim(self):
        for file in ("README.md","docs/WHAT_YOU_CAN_BUILD.md"):
            text=(ROOT/file).read_text(encoding="utf-8")
            self.assertIn("read-only",text)
            self.assertIn("27",text)
        self.assertIn("cannot create", (ROOT/"README.md").read_text(encoding="utf-8"))

    def test_local_command_examples_exist(self):
        for name in ("install.cmd","demo.cmd","install.sh",
                     "scripts/order_demo_linux.sh","scripts/live_test.py",
                     "scripts/gtm_benchmark.py"):
            with self.subTest(command=name):
                self.assertTrue((ROOT/name).is_file())

    def test_published_demo_scope_matches_actual_test(self):
        readme=(ROOT/"README.md").read_text(encoding="utf-8")
        playbook=(ROOT/"docs/WHAT_YOU_CAN_BUILD.md").read_text(encoding="utf-8")
        for page in (readme,playbook):
            self.assertIn("12",page)
            self.assertIn("two",page.lower())
            self.assertRegex(page.lower(),r"\b(?:four|4)\b")
        self.assertIn("synthetic",readme.lower())
        self.assertIn("not production aws",readme.lower())

if __name__=="__main__":
    unittest.main()
