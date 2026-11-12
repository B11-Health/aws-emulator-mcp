"""Scorecard guardrails: avoid vanity pass rates and misleading percentiles."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from gtm_benchmark import percentile, gate

class BenchmarkMathTests(unittest.TestCase):
    def test_nearest_rank_p95_is_conservative(self):
        self.assertEqual(percentile([7.1,6.5,7.4,6.1,7.3],.95),7.4)
    def test_empty_latencies_cannot_pass(self):
        self.assertIsNone(percentile([],.95))
    def test_gate_explicitly_records_failure(self):
        result=gate("reliability",False,"4/5","5/5")
        self.assertEqual(result["status"],"FAIL")
        self.assertTrue(result["required"])
    def test_gates_never_infer_release_approval(self):
        self.assertNotIn("public_release_approved",gate("unit",True,90,90))

if __name__=="__main__":unittest.main()
