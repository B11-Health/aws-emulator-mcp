"""Independent static QA for the versioned, credential-free PR blueprint review."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import unittest
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples/architecture/review"
OUTPUT = EXAMPLE / "reference"


class ArchitectureReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = json.loads((EXAMPLE / "before.json").read_text(encoding="utf-8"))
        cls.after = json.loads((EXAMPLE / "after.json").read_text(encoding="utf-8"))
        cls.report = json.loads((OUTPUT / "report.json").read_text(encoding="utf-8"))

    def test_data_only_blueprint_diff(self):
        report = self.report
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["reviewKind"], "local-blueprint-comparison")
        for key in ("awsAccountAccess", "cloudFormationChangeSet",
                    "awsDeployment", "emulatorTestExecuted"):
            self.assertFalse(report[key])
        self.assertEqual(report["counts"]["added"], 1)
        self.assertEqual(report["counts"]["modified"], 1)
        self.assertEqual(report["counts"]["unchanged"], 1)
        self.assertEqual(report["counts"]["removed"], 0)
        self.assertEqual(report["highRiskCount"], 1)

    def test_logical_ids_correspond_to_actual_blueprint_difference(self):
        b = {r["id"]: r for r in self.before["resources"]}
        a = {r["id"]: r for r in self.after["resources"]}
        changes = {x["id"]: x for x in self.report["changes"]}
        self.assertEqual(set(changes), set(b) | set(a))
        self.assertEqual(changes["FulfillmentQueue"]["status"], "added")
        self.assertNotIn("FulfillmentQueue", b)
        self.assertEqual(changes["OrdersTable"]["status"], "modified")
        self.assertEqual(changes["OrdersTable"]["risk"], "high")
        self.assertNotEqual(b["OrdersTable"]["partitionKey"],
                            a["OrdersTable"]["partitionKey"])
        self.assertEqual(changes["ReceiptsBucket"]["status"], "unchanged")
        self.assertEqual(b["ReceiptsBucket"], a["ReceiptsBucket"])

    def test_svg_is_static_and_visual_node_ids_match_both_inputs(self):
        p = OUTPUT / "architecture-diff.svg"
        contents = p.read_text(encoding="utf-8")
        root = ET.fromstring(contents)
        self.assertTrue(root.tag.endswith("svg"))
        nodes = [x for x in root.iter() if "data-node-id" in x.attrib]
        self.assertEqual(len(nodes), 5)
        self.assertEqual({x.attrib["data-node-id"] for x in nodes},
                         {"ReceiptsBucket", "OrdersTable", "FulfillmentQueue"})
        self.assertEqual(sum(x.attrib["data-node-id"] == "OrdersTable"
                             for x in nodes), 2)
        self.assertEqual(sum(x.attrib["data-node-id"] == "FulfillmentQueue"
                             for x in nodes), 1)
        self.assertIn("key orderId", contents)
        self.assertIn("key orderRef", contents)
        for dangerous in ("<script", "<iframe", "<foreignObject", "<image", "javascript:"):
            self.assertNotIn(dangerous, contents)
        self.assertIn("NOT predicted CloudFormation actions", contents)

    def test_hashes_cover_every_generated_reference_artifact(self):
        artifacts = self.report["artifacts"]
        self.assertEqual(len(artifacts), 10)
        for name, metadata in artifacts.items():
            with self.subTest(name=name):
                raw = (OUTPUT / name).read_bytes()
                self.assertEqual(metadata["bytes"], len(raw))
                self.assertEqual(metadata["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(self.report["beforeSha256"],
            hashlib.sha256((OUTPUT / "before-architecture.json").read_bytes()).hexdigest())
        self.assertEqual(self.report["afterSha256"],
            hashlib.sha256((OUTPUT / "after-architecture.json").read_bytes()).hexdigest())

    def test_cloudformation_templates_are_source_level_drafts(self):
        before = (OUTPUT / "before-template.yaml").read_text(encoding="utf-8")
        after = (OUTPUT / "after-template.yaml").read_text(encoding="utf-8")
        self.assertIn("AWS::DynamoDB::Table", before)
        self.assertIn("AWS::SQS::Queue", after)
        self.assertNotIn("AWS::SQS::Queue", before)
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML optional; separate CI cfn-lint job validates drafts")
        b = yaml.safe_load(before)
        a = yaml.safe_load(after)
        self.assertEqual(set(b["Resources"]), {"ReceiptsBucket", "OrdersTable"})
        self.assertEqual(set(a["Resources"]),
                         {"ReceiptsBucket", "OrdersTable", "FulfillmentQueue"})
        self.assertNotEqual(
            b["Resources"]["OrdersTable"]["Properties"]["KeySchema"],
            a["Resources"]["OrdersTable"]["Properties"]["KeySchema"])
        self.assertEqual(
            a["Resources"]["ReceiptsBucket"],
            b["Resources"]["ReceiptsBucket"])

    def test_action_has_no_cloud_deployment_credential_or_comment_surface(self):
        yamltext = (ROOT / ".github/actions/architecture-review/action.yml").read_text()
        testtext = (ROOT / ".github/workflows/architecture-review-selftest.yml").read_text()
        self.assertIn("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", yamltext)
        self.assertIn("github.event.pull_request.base.sha", yamltext)
        self.assertIn("contents: read", testtext)
        self.assertIn("pull_request:", testtext)
        for forbidden in ("pull_request_target", "secrets.", "aws-actions/configure-aws-credentials",
                          "peter-evans/create-pull-request", "actions/github-script"):
            self.assertNotIn(forbidden, yamltext + testtext)

    def test_marketplace_root_metadata_and_separate_hosted_gate(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML optional; hosted CI validates root action YAML")
        action = yaml.safe_load((ROOT / "action.yml").read_text())
        self.assertEqual(action["runs"]["using"], "composite")
        self.assertEqual(action["branding"]["color"], "blue")
        self.assertEqual(len(action["runs"]["steps"]), 3)
        run = action["runs"]["steps"][1]
        self.assertIn('scripts/architecture_review.mjs', run["run"])
        self.assertIn('github.action_path', run["env"]["ACTION_SOURCE_ROOT"])
        self.assertNotIn('secrets.', str(action))
        self.assertNotIn('pull_request_target', str(action))
        wf = yaml.safe_load((ROOT / ".github/workflows/architecture-review-selftest.yml").read_text())
        self.assertEqual(len(wf["jobs"]), 2)
        self.assertIn('marketplace-root-entrypoint', wf['jobs'])
        self.assertEqual(wf['permissions']['contents'], 'read')

    def test_package_includes_review_and_preview_sources(self):
        manifest = json.loads((ROOT / "package.json").read_text())
        required = {
            "scripts/architecture_review.mjs",
            "docs/ARCHITECTURE_REVIEW.md",
            "examples/architecture/review/before.json",
            "examples/architecture/review/after.json",
            "examples/architecture/review/reference/architecture-diff.svg",
            "examples/architecture/review/reference/report.json",
            "examples/architecture/review/reference/summary.md"
        }
        self.assertTrue(required.issubset(set(manifest["files"])))


if __name__ == "__main__":
    unittest.main()
