"""Independent stdlib verification of versioned Architecture Studio artifacts."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "examples/architecture/reference"
sys.path.insert(0, str(ROOT / "src"))
from aws_emulator_mcp import contract_case


class ArchitectureArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((ARTIFACTS / "architecture.json").read_text())
        cls.template = json.loads((ARTIFACTS / "template.json").read_text())
        cls.contract = json.loads((ARTIFACTS / "contract.json").read_text())
        cls.report = json.loads((ARTIFACTS / "report.json").read_text())

    def test_cloudformation_resources_and_output_targets(self):
        resource_ids = set(self.template["Resources"])
        self.assertEqual(resource_ids, {r["id"] for r in self.manifest["resources"]})
        self.assertEqual(len(self.template["Resources"]), 3)
        actual_types = {r["Type"] for r in self.template["Resources"].values()}
        self.assertEqual(actual_types, {
            "AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::SQS::Queue"})
        self.assertEqual(
            {entry["Value"]["Ref"] for entry in self.template["Outputs"].values()},
            resource_ids)
        for resource in self.template["Resources"].values():
            self.assertNotIn("Role", resource)
            self.assertNotIn("RoleArn", resource)
        self.assertNotIn(self.manifest["actor"]["id"], resource_ids)

    def test_svg_ids_and_edges_match_manifest_and_cloudformation(self):
        root = ET.parse(ARTIFACTS / "diagram.svg").getroot()
        self.assertTrue(root.tag.endswith("svg"))
        nodes = {
            element.attrib["data-resource-id"]: element.attrib["data-type"]
            for element in root.iter() if "data-resource-id" in element.attrib
        }
        self.assertEqual(nodes, {r["id"]: r["type"]
                                 for r in self.manifest["resources"]})
        arrows = {x.attrib["data-flow"] for x in root.iter()
                  if "data-flow" in x.attrib}
        self.assertEqual(arrows, {f"{flow['from']}:{flow['to']}"
                                  for flow in self.manifest["flows"]})
        actors = {x.attrib["data-actor-id"] for x in root.iter()
                  if "data-actor-id" in x.attrib}
        self.assertEqual(actors, {self.manifest["actor"]["id"]})

    def test_drawio_editable_cells_share_exact_nodes_and_edges(self):
        root = ET.parse(ARTIFACTS / "diagram.drawio").getroot()
        self.assertEqual(root.tag, "mxfile")
        cells = {cell.get("id"): cell for cell in root.iter("mxCell")}
        actors = {x for x in cells if x.startswith("actor-")}
        nodes = {x for x in cells if x.startswith("resource-")}
        self.assertEqual(actors, {"actor-" + self.manifest["actor"]["id"]})
        self.assertEqual(nodes, {"resource-" + r for r in self.template["Resources"]})
        edges = [cell for cell in cells.values() if cell.get("edge") == "1"]
        self.assertEqual(len(edges), len(self.manifest["flows"]))
        for edge in edges:
            self.assertIn(edge.get("source"), actors)
            self.assertIn(edge.get("target"), nodes)
            self.assertTrue(any(edge.get("id") == f"flow-{f['from']}-{f['to']}"
                                for f in self.manifest["flows"]))
        self.assertFalse(any(x.tag == "script" for x in root.iter()))

    def test_contract_is_valid_and_uses_synthetic_fixture_resources(self):
        self.assertIs(contract_case.validate(self.contract), self.contract)
        self.assertEqual(len(self.contract["steps"]), 14)
        self.assertEqual(
            {s["service"] for s in self.contract["steps"]},
            {"s3", "dynamodb", "sqs"})
        as_text = json.dumps(self.contract)
        self.assertIn('"$fixture"', as_text)
        self.assertNotIn("AKIA", as_text)
        self.assertNotIn('"endpoint_url"', as_text)
        self.assertNotIn('"roleArn"', as_text)
        self.assertNotIn('"fault"', as_text)

    def test_manifest_hashes_cover_every_output_excluding_self(self):
        for filename, info in self.report["artifacts"].items():
            content = (ARTIFACTS / filename).read_bytes()
            self.assertEqual(info["bytes"], len(content))
            self.assertEqual(info["sha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(self.report["sourceSha256"],
                         self.report["artifacts"]["architecture.json"]["sha256"])
        self.assertFalse(self.report["validated"]["awsDeployment"])
        self.assertFalse(self.report["validated"]["emulatorContractExecuted"])
        self.assertEqual(len(self.report["warnings"]), 4)

    def test_template_yaml_matches_json_with_optional_yaml_parser(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML optional; standalone cfn-lint CI step validates YAML")
        parsed = yaml.safe_load((ARTIFACTS / "template.yaml").read_text())
        self.assertEqual(parsed, self.template)

    def test_compiler_shipped_in_package_and_requires_no_cloud_credentials(self):
        package = json.loads((ROOT / "package.json").read_text())
        required = {
            "scripts/architecture_studio.mjs",
            "examples/architecture/order-intake.json",
            "docs/ARCHITECTURE_STUDIO.md",
            *(str(p.relative_to(ROOT)).replace("\\", "/")
              for p in ARTIFACTS.iterdir() if p.is_file())
        }
        self.assertTrue(required.issubset(set(package["files"])), required)


if __name__ == "__main__":
    unittest.main()
