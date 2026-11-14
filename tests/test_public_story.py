"""Keep our public-facing promises compatible with shipped commands and files."""
from pathlib import Path
import re
import unittest

ROOT=Path(__file__).resolve().parents[1]
PAGES=("README.md","docs/WHAT_YOU_CAN_BUILD.md","docs/LAUNCH_DEMO.md",
       "docs/linkedin-draft.md","docs/APP_DEBUGGING.md",
       "docs/ONBOARDING.md","docs/DEMO_GALLERY.md")

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
        lead=(ROOT/"README.md").read_text(encoding="utf-8")[:2700]
        self.assertIn("Your AWS playground",lead)
        self.assertIn("No AWS account",lead)
        full=(ROOT/"README.md").read_text(encoding="utf-8")
        for service in ("S3","DynamoDB","SQS","EC2","SNS","IAM"):
            self.assertIn(service,full)

    def test_public_identity_has_no_unrelated_nonprofit_brand(self):
        for name in ("README.md", "docs/DOCKER_NPM_BETA.md"):
            content=(ROOT/name).read_text(encoding="utf-8")
            self.assertNotIn("codegym-aws",content)
            self.assertNotIn("@codegym/",content)
            self.assertNotIn("Code Gym",content)
        pkg=(ROOT/"package.json").read_text(encoding="utf-8")
        self.assertIn('"name": "aws-emulator-mcp"',pkg)

    def test_no_remote_write_claim(self):
        for file in ("README.md","docs/WHAT_YOU_CAN_BUILD.md"):
            text=(ROOT/file).read_text(encoding="utf-8")
            self.assertIn("read-only",text)
            self.assertIn("29",text)
        self.assertIn("does not execute code supplied by an agent",
                      (ROOT/"README.md").read_text(encoding="utf-8"))

    def test_readme_media_is_real_and_repo_local(self):
        import xml.etree.ElementTree as ET
        body=(ROOT/"README.md").read_text(encoding="utf-8")
        for match in re.findall(r'<(?:img|a)\s+[^>]*?(?:src|href)="([^"]+)"',body):
            if match.startswith(("http://","https://","#","mailto:")):
                continue
            f=ROOT/match.split("#",1)[0]
            with self.subTest(asset=match):
                self.assertTrue(f.is_file(), f"Missing README asset {match}")
        for filename in ("hero.svg", "architecture.svg"):
            image=ROOT/"docs/assets"/filename
            self.assertLess(image.stat().st_size,100_000)
            root=ET.parse(image).getroot()
            self.assertEqual(root.tag,"{http://www.w3.org/2000/svg}svg")
            self.assertIn("title", image.read_text(encoding="utf-8"))
        gif=ROOT/"docs/assets/demos/tour-preview.gif"
        self.assertTrue(gif.read_bytes().startswith((b"GIF89a",b"GIF87a")))
        self.assertLess(gif.stat().st_size,3_000_000)
        for name in ("product-tour","fix-the-bug","getting-started","linkedin-launch"):
            movie=ROOT/"docs/assets/demos"/(name+".mp4")
            poster=ROOT/"docs/assets/demos"/(name+"-poster.jpg")
            self.assertEqual(movie.read_bytes()[4:8],b"ftyp")
            self.assertTrue(poster.read_bytes().startswith(b"\xff\xd8"))
            self.assertLess(movie.stat().st_size,5_000_000)

    def test_readme_coverage_claims_are_specific_and_verifiable(self):
        import json
        import sys
        sys.path.insert(0, str(ROOT / "src"))
        from aws_emulator_mcp import aws_sdk
        body=(ROOT/"README.md").read_text(encoding="utf-8")
        self.assertIn("29 curated MCP tools",body)
        self.assertIn("5 Docker-only tools",body)
        self.assertIn("436 service models",body)
        self.assertIn("20/20 read-only",body)
        self.assertIn("not yet published on npm",body)
        self.assertNotIn("img.shields.io/npm/v/",body)
        self.assertIn("actions/workflows/tests.yml/badge.svg?branch=master",body)
        evidence=json.loads((ROOT/"docs/evidence/coverage-aws-emulator-1.0.343.json").read_text(encoding="utf-8"))
        self.assertEqual(evidence["modeledServiceCount"],436)
        self.assertEqual(evidence["successfulProbes"],20)
        self.assertEqual([(item["service"],item["operation"]) for item in evidence["results"]],
                         list(aws_sdk.READ_ONLY_PROBES))
        self.assertTrue(all(item["status"]=="responded" for item in evidence["results"]))

    def test_real_app_debugging_evidence_is_verifiable(self):
        import json
        data=json.loads((ROOT/"docs/evidence/app-debug-aws-emulator-1.0.365.json").read_text(encoding="utf-8"))
        self.assertTrue(data["passed"])
        self.assertTrue(data["bugReproduced"])
        self.assertTrue(data["referenceFixVerified"])
        self.assertEqual(data["before"]["observed"]["queueEvents"],2)
        self.assertEqual(data["after"]["observed"]["queueEvents"],1)
        for run in ("before","after"):
            self.assertEqual(len(data[run]["cleanup"]),7)
            self.assertTrue(all(item["passed"] for item in data[run]["cleanup"]))
        import hashlib
        self.assertEqual(data["referencePatchSha256"],
            hashlib.sha256((ROOT/"examples/order-intake/reference.patch").read_bytes()).hexdigest())

    def test_local_command_examples_exist(self):
        for name in ("install.cmd","demo.cmd","install.sh",
                     "scripts/order_demo_linux.sh","scripts/live_test.py",
                     "scripts/gtm_benchmark.py"):
            with self.subTest(command=name):
                self.assertTrue((ROOT/name).is_file())

    def test_published_demo_scope_matches_actual_test(self):
        readme=(ROOT/"README.md").read_text(encoding="utf-8")
        self.assertIn("SQS fulfillment messages",readme)
        self.assertIn("7/7",readme)
        self.assertIn("2",readme)
        self.assertIn("1",readme)
        self.assertIn("synthetic",readme.lower())
        self.assertIn("not production aws",readme.lower())
        self.assertIn("bundled reference fix",readme)
        self.assertNotIn("Code Gym",readme)
        self.assertNotIn("Real tools. Real emulator.",readme)
        self.assertNotIn("Kokoro",readme)

    def test_onboarding_controls_and_saved_evidence(self):
        text=(ROOT/"docs/onboarding/tour.js").read_text(encoding="utf-8")
        html=(ROOT/"docs/onboarding/index.html").read_text(encoding="utf-8")
        for item in ('Find the bug','Verify the fix','20/20','2','1'):
            self.assertIn(item,text+html)
        for control in ('id="next"','id="back"','id="play"','id="pointer"'):
            self.assertIn(control,html)
        self.assertIn('pointermove',text)
        self.assertIn('prefers-reduced-motion',
                      (ROOT/"docs/onboarding/style.css").read_text(encoding="utf-8"))

if __name__=="__main__":
    unittest.main()
