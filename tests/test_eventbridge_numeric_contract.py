"""Offline source-level checks for the EventBridge 2^53 boundary fixture."""
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))
from aws_emulator_mcp.contract_case import validate

FILE=ROOT/"examples/contracts/eventbridge-numeric-boundary.json"

class TestEventBridgeNumericContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plan=json.loads(FILE.read_text(encoding="utf-8"))

    def test_schema_and_three_read_only_probes(self):
        self.assertIs(validate(self.plan),self.plan)
        self.assertEqual(len(self.plan["steps"]),3)
        self.assertEqual(
            [(x["service"],x["operation"]) for x in self.plan["steps"]],
            [("events","TestEventPattern")]*3)
        self.assertFalse(any("fault" in x for x in self.plan["steps"]))

    def test_distinct_integer_literals_survive_wire_json(self):
        expected=[2**53,2**53+1,42]
        actual=[]
        rules=[]
        for step in self.plan["steps"]:
            wire=step["parameters"]
            self.assertIsInstance(wire["Event"],str)
            self.assertIsInstance(wire["EventPattern"],str)
            event=json.loads(wire["Event"])
            self.assertIs(type(event["detail"]["orderId"]),int)
            actual.append(event["detail"]["orderId"])
            rules.append(wire["EventPattern"])
            self.assertEqual(json.loads(wire["EventPattern"]),
                {"detail":{"orderId":[2**53]}})
        self.assertEqual(actual,expected)
        self.assertEqual(len(set(rules)),1)

    def test_positive_and_negative_assertions_are_explicit(self):
        labels=[x["id"] for x in self.plan["steps"]]
        self.assertEqual(labels,["exact","adjacent","distant"])
        expected=[True,False,False]
        actual=[]
        for step in self.plan["steps"]:
            assertions=step["expect"]["assertions"]
            self.assertEqual(len(assertions),1)
            self.assertEqual(assertions[0]["path"],"Result")
            self.assertIs(type(assertions[0]["equals"]),bool)
            actual.append(assertions[0]["equals"])
        self.assertEqual(actual,expected)

    def test_negative_control_tampering_is_detectable(self):
        """A fixture without the exact adjacent-false check is not acceptable."""
        changed=json.loads(json.dumps(self.plan))
        changed["steps"][1]["expect"]["assertions"][0]["equals"]=True
        desired=[step["expect"]["assertions"][0]["equals"]
                 for step in self.plan["steps"]]
        modified=[step["expect"]["assertions"][0]["equals"]
                  for step in changed["steps"]]
        self.assertEqual(desired,[True,False,False])
        self.assertNotEqual(modified,desired)

if __name__ == "__main__":
    unittest.main()
