"""Guard bounded emulator table activation without requiring botocore in unit tests."""
import sys
from pathlib import Path
from types import ModuleType
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from aws_emulator_mcp import contract_case, server


class FakeClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}
        super().__init__("redacted fake SDK error")


class FakeDdbClient:
    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def describe_table(self, **params):
        self.calls.append(params["TableName"])
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return {"Table": {"TableStatus": result}}


class ReadinessTests(unittest.TestCase):
    def with_botocore(self):
        boto = ModuleType("botocore")
        boto.__path__ = []
        errors = ModuleType("botocore.exceptions")
        errors.ClientError = FakeClientError
        return patch.dict(sys.modules, {"botocore": boto, "botocore.exceptions": errors})

    def test_active_first_try(self):
        with self.with_botocore(), patch.object(contract_case.time, "sleep") as sleep:
            client = FakeDdbClient(["ACTIVE"])
            self.assertEqual(contract_case._wait_created_table_active(client, "test-table"), 1)
            self.assertEqual(client.calls, ["test-table"])
            sleep.assert_not_called()

    def test_create_table_eventual_consistency(self):
        with self.with_botocore(), patch.object(contract_case.time, "sleep") as sleep:
            client = FakeDdbClient([
                FakeClientError("ResourceNotFoundException"), "CREATING", "ACTIVE"])
            self.assertEqual(contract_case._wait_created_table_active(client, "test-table"), 3)
            self.assertEqual(client.calls, ["test-table"] * 3)
            self.assertEqual(sleep.call_count, 2)

    def test_unexpected_sdk_failure_is_not_swallowed(self):
        with self.with_botocore(), patch.object(contract_case.time, "sleep") as sleep:
            client = FakeDdbClient([FakeClientError("AccessDeniedException")])
            with self.assertRaises(FakeClientError):
                contract_case._wait_created_table_active(client, "test-table")
            sleep.assert_not_called()

    def test_readiness_bounded_at_40_describes(self):
        with self.with_botocore(), patch.object(contract_case.time, "sleep") as sleep:
            client = FakeDdbClient(["CREATING"] * 40)
            with self.assertRaisesRegex(server.LocalError, "did not become ACTIVE"):
                contract_case._wait_created_table_active(client, "test-table")
            self.assertEqual(len(client.calls), 40)
            self.assertEqual(sleep.call_count, 39)

    def test_invalid_table_identifier_fails_before_call(self):
        with self.with_botocore():
            client = FakeDdbClient([])
            for name in ("", "x" * 256, None, 45):
                with self.subTest(name=name):
                    with self.assertRaises(server.LocalError):
                        contract_case._wait_created_table_active(client, name)
            self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
