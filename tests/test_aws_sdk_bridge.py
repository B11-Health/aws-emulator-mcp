"""SDK model bridge tests: local-only routing, validation, and safe serialization."""
import datetime
import json
from pathlib import Path
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from aws_emulator_mcp import aws_sdk, server as m


class FakeMetadata:
    method_to_api_mapping = {"list_buckets": "ListBuckets"}


class FakeClient:
    meta = FakeMetadata()

    def list_buckets(self):
        return {
            "Buckets": [{"Name": "local-test",
                         "CreationDate": datetime.datetime(2026, 11, 13, tzinfo=datetime.timezone.utc)}],
            "ResponseMetadata": {"HTTPHeaders": {"authorization": "should-not-leak"}},
        }


class SDKBridgeTests(unittest.TestCase):
    def test_checksum_streaming_body_is_bounded_and_closed(self):
        class Stream:
            def __init__(self, payload):
                self.payload = payload
                self.closed = False
            def read(self, limit):
                self.limit = limit
                return self.payload[:limit]
            def close(self):
                self.closed = True
        Stream.__name__ = "StreamingChecksumBody"
        Stream.__module__ = "botocore.httpchecksum"
        raw = Stream(b"emulator-readback")
        value = aws_sdk._safe(raw)
        self.assertEqual(value["encoding"], "base64")
        self.assertEqual(__import__("base64").b64decode(value["data"]), b"emulator-readback")
        self.assertTrue(raw.closed)
        self.assertEqual(raw.limit, aws_sdk.MAX_OUTPUT_BYTES + 1)

    def test_safe_json_strips_metadata(self):
        v = aws_sdk._safe(FakeClient().list_buckets())
        self.assertEqual(v["Buckets"][0]["Name"], "local-test")
        self.assertNotIn("ResponseMetadata", v)
        self.assertIn("2026-11-13", v["Buckets"][0]["CreationDate"])
        self.assertEqual(json.loads(json.dumps(v))["Buckets"][0]["Name"], "local-test")

    def test_discover_and_invoke_use_modeled_operation(self):
        with patch.object(aws_sdk, "_client", return_value=(m, None, FakeClient(), Exception, Exception)):
            result = aws_sdk.invoke("s3", "ListBuckets")
        self.assertTrue(result["passed"])
        self.assertEqual(result["endpoint"], "https://127.0.0.1:9297")
        self.assertEqual(result["result"]["Buckets"][0]["Name"], "local-test")
        self.assertNotIn("ResponseMetadata", result["result"])

    def test_unmodeled_operation_is_rejected(self):
        with patch.object(aws_sdk, "_client", return_value=(m, None, FakeClient(), Exception, Exception)):
            with self.assertRaisesRegex(m.LocalError, "Operation not present"):
                aws_sdk.invoke("s3", "DeleteTheInternet")

    def test_oversized_and_invalid_parameters_fail(self):
        with patch.object(aws_sdk, "_client", return_value=(m, None, FakeClient(), Exception, Exception)):
            for parameters in ([1, 2], {"value": "x" * 65537}, {"bad": float("nan")}):
                with self.subTest(parameters_type=type(parameters).__name__):
                    with self.assertRaises(m.LocalError):
                        aws_sdk.invoke("s3", "ListBuckets", parameters)

    def test_broad_tools_not_registered_in_native_python(self):
        # Existing local native stdlib-only MCP remains fixed and safe.
        if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
            self.assertNotIn("aws_sdk_invoke", m.FUNCTIONS)
            self.assertEqual(len(m.TOOLS), 29)

    def test_discover_paginates_every_model_and_supports_filtering(self):
        class Model:
            operation_names = ["DescribeBar", "CreateFoo", "DescribeFoo", "ListFoos"]
            def operation_model(self, name):
                class Operation:
                    input_shape = None
                return Operation()
        class Session:
            def get_available_services(self): return ["s3", "ec2", "lambda", "iam"]
            def get_service_model(self, service): return Model()
        class SessionModule:
            @staticmethod
            def get_session(): return Session()
        fake = (m, SessionModule, None, Exception, Exception)
        with patch.object(aws_sdk, "_runtime", return_value=fake):
            page = aws_sdk.discover(offset=1, limit=2)
            self.assertEqual(page["modeledServiceCount"], 4)
            self.assertEqual(page["services"], ["iam", "lambda"])
            self.assertEqual(page["nextOffset"], 3)
            exact = aws_sdk.discover("s3", query="Describe", offset=1, limit=1)
            self.assertEqual(exact["matchedOperationCount"], 2)
            self.assertEqual(exact["operations"][0]["operation"], "DescribeFoo")
            self.assertEqual(exact["operations"][0]["status"], "modeled_not_verified")
            self.assertIsNone(exact["nextOffset"])

    def test_discover_rejects_unsafe_page_arguments(self):
        for offset, limit, query in ((-1, 10, None), (0, 0, None),
                                     (0, 101, None), (True, 1, None),
                                     (0, False, None), (0, 10, "x"*65)):
            with self.subTest(offset=offset,limit=limit), self.assertRaises(ValueError):
                aws_sdk._page(offset, limit, query)

    def test_readonly_probe_audit_never_calls_arbitrary_method(self):
        class Session:
            def get_available_services(self): return ["ec2", "s3"]
        class SessionModule:
            @staticmethod
            def get_session(): return Session()
        class Meta:
            method_to_api_mapping={"describe_vpcs":"DescribeVpcs"}
        class Client:
            meta=Meta()
            def describe_vpcs(self): return {"Vpcs":[]}
        fake=(m,SessionModule,None,Exception,Exception)
        with patch.object(aws_sdk, "_runtime", return_value=fake), \
             patch.object(aws_sdk, "_client", return_value=(m,None,Client(),Exception,Exception)) as call, \
             patch.object(m, "doctor", return_value={"emulator_version":"test-version"}):
            report=aws_sdk.coverage("ec2")
            self.assertEqual(report["totalProbes"],1)
            self.assertEqual(report["successfulProbes"],1)
            self.assertEqual(report["emulatorVersion"],"test-version")
            self.assertEqual(report["results"][0]["operation"],"DescribeVpcs")
            self.assertEqual(report["results"][0]["status"],"responded")
            call.assert_called_once_with("ec2")
            other=aws_sdk.coverage("s3")
            self.assertEqual(other["totalProbes"],1)
            self.assertEqual(other["results"][0]["status"],"not_modeled")
            self.assertEqual(aws_sdk.coverage.__doc__.find("AWS fidelity")>=0, True)

    def test_coverage_distinguishes_unprobed_service(self):
        class Session:
            def get_available_services(self): return ["ec2", "athena"]
        class SessionModule:
            @staticmethod
            def get_session(): return Session()
        with patch.object(aws_sdk, "_runtime", return_value=(m,SessionModule,None,Exception,Exception)), \
             patch.object(m,"doctor",return_value={"emulator_version":"test"}):
            report=aws_sdk.coverage("athena")
            self.assertEqual(report["serviceProbeStatus"],"not_probed")
            self.assertEqual(report["totalProbes"],0)
            with self.assertRaises(m.LocalError):
                aws_sdk.coverage("not-real")

    def test_model_bridge_requires_container(self):
        if os.environ.get("AWS_EMULATOR_MCP_ISOLATED_LAB") != "1":
            with self.assertRaisesRegex(m.LocalError, "isolated AWS Emulator MCP Docker"):
                aws_sdk._runtime()


if __name__ == "__main__":
    unittest.main()
