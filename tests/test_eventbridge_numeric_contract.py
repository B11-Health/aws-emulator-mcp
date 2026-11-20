"""Offline contract-engine checks for the EventBridge 2^53 boundary fixture."""
import copy
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"src"))
from aws_emulator_mcp import aws_sdk, contract_case, server
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

    def _run_inert_contract(self, plan, *, always_true=False):
        """Call the REAL contract engine behind inert SDK and identity mocks.

        A fake SDK records all calls. Socket and subprocess constructors are
        forbidden, so this test cannot start Docker or contact an endpoint.
        The local account marker is explicitly MOCKED, not independently proven.
        """
        calls=[]
        private_response="SYNTHETIC_PRIVATE_RESPONSE_MUST_NOT_LEAK"

        class FakeEventsClient:
            class Meta:
                method_to_api_mapping={"test_event_pattern": "TestEventPattern"}
            meta=Meta()

            def test_event_pattern(self, *, EventPattern, Event):
                # Both inputs remain JSON strings until parsed by Python,
                # whose integers preserve the adjacent values exactly.
                self_test.assertIsInstance(EventPattern,str)
                self_test.assertIsInstance(Event,str)
                pattern=json.loads(EventPattern)["detail"]["orderId"][0]
                actual=json.loads(Event)["detail"]["orderId"]
                self_test.assertIs(type(actual),int)
                calls.append(actual)
                return {"Result": True if always_true else actual==pattern,
                        "SyntheticPrivateEcho":private_response}

        self_test=self
        stdout=StringIO()
        stderr=StringIO()
        with (mock.patch.dict(os.environ,{"AWS_EMULATOR_MCP_ISOLATED_LAB":"1"},clear=True),
              mock.patch.object(server,"doctor",return_value={
                  "ready":True,"emulator_version":"MOCK_ONLY_NOT_REAL_AWS"}),
              mock.patch.object(server,"identity",return_value={"Account":"000000000000"}),
              mock.patch.object(aws_sdk,"_client",return_value=(
                  None,None,FakeEventsClient(),None,None)),
              mock.patch.object(aws_sdk,"_safe",side_effect=lambda value:value),
              mock.patch("socket.socket",side_effect=AssertionError("network disabled")),
              mock.patch("socket.create_connection",side_effect=AssertionError("network disabled")),
              mock.patch("subprocess.Popen",side_effect=AssertionError("Docker/process disabled")),
              mock.patch("subprocess.run",side_effect=AssertionError("Docker/process disabled")),
              redirect_stdout(stdout),redirect_stderr(stderr)):
            result=contract_case.execute(plan)

        self.assertEqual(stdout.getvalue(),"")
        self.assertEqual(stderr.getvalue(),"")
        self.assertNotIn(private_response,json.dumps(result))
        self.assertEqual(result["scope"],
            "Local AWS Emulator SDK behavior only; not AWS or IAM fidelity")
        self.assertEqual(result["emulatorVersion"],"MOCK_ONLY_NOT_REAL_AWS")
        return result,calls

    def test_wrong_adjacent_expected_result_stops_real_engine_at_step_two(self):
        """Negative control must fail in the assertion engine, not just a list diff."""
        baseline,baseline_calls=self._run_inert_contract(self.plan)
        self.assertIs(baseline["passed"],True)
        self.assertEqual(baseline["passedSteps"],3)
        self.assertEqual(baseline["totalSteps"],3)
        self.assertEqual([step["id"] for step in baseline["steps"]],
                         ["exact","adjacent","distant"])
        self.assertEqual(baseline_calls,[2**53,2**53+1,42])
        self.assertTrue(all(step["passed"] for step in baseline["steps"]))

        changed=copy.deepcopy(self.plan)
        changed["steps"][1]["expect"]["assertions"][0]["equals"]=True
        self.assertIs(validate(changed),changed)
        failed,calls=self._run_inert_contract(changed)
        self.assertIs(failed["passed"],False)
        self.assertEqual(failed["passedSteps"],1)
        self.assertEqual(failed["totalSteps"],3)
        self.assertEqual([step["id"] for step in failed["steps"]],
                         ["exact","adjacent"])
        self.assertEqual(calls,[2**53,2**53+1],
                         "The distant third SDK step must not be called")
        self.assertEqual(failed["steps"][1]["observed"],"success")
        self.assertEqual(failed["steps"][1]["assertions"],
                         [{"path":"Result","passed":False}])

    def test_sdk_that_always_returns_true_cannot_claim_adjacent_negative_pass(self):
        """If the matcher collapses large integers, the original plan must fail."""
        failed,calls=self._run_inert_contract(self.plan,always_true=True)
        self.assertIs(failed["passed"],False)
        self.assertEqual(failed["passedSteps"],1)
        self.assertEqual([step["id"] for step in failed["steps"]],
                         ["exact","adjacent"])
        self.assertEqual(calls,[2**53,2**53+1])
        self.assertEqual(failed["steps"][1]["assertions"],
                         [{"path":"Result","passed":False}])

if __name__ == "__main__":
    unittest.main()
