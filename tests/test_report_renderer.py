"""Offline dashboard verification, including report-data injection safety."""
from pathlib import Path
import json
import sys
import tempfile
import unittest

SCRIPTS=Path(__file__).resolve().parents[1]/"scripts"
sys.path.insert(0,str(SCRIPTS))
from render_report import payload,render

class ReportRendererTests(unittest.TestCase):
    def example(self):
        return {
            "timestamp_utc":"2026-11-12T19:00:00+00:00",
            "version":"0.3.0",
            "engineering_pass":True,
            "public_release_approved":False,
            "repetitions":5,
            "gates":[
                {"name":"tool_catalog","status":"PASS","observed":27,"threshold":27},
                {"name":"order_workflow_p95","status":"PASS","observed":7.3,"threshold":"<= 12s"},
            ],
            "measurements":{
                "tool_count":27,"order_p95_seconds":7.3,
                "orders":[{"ms":7100,"steps":12,"recovery":2,"cleanup":4,"passed":True}],
                "selftest":[{"ms":6000,"checks":13,"cleanup":4,"passed":True}],
            },
            "independent_release_blockers":["fresh Windows test"],
        }

    def test_generates_offline_report(self):
        output=render(self.example())
        self.assertIn("<!doctype html>",output)
        self.assertIn("Ship proof.",output)
        self.assertIn('id="latency-chart"',output)
        self.assertIn('id="metrics"',output)
        self.assertIn("7.3",output)
        self.assertNotIn('src="https:',output)
        self.assertNotIn('href="https:',output)

    def test_never_claims_public_approval_from_input(self):
        r=self.example()
        r["public_release_approved"]=True
        out=render(r)
        self.assertIn('"public_release_approved":false',out)
        self.assertNotIn('"public_release_approved":true',out)

    def test_html_data_boundary_escapes_script_and_tags(self):
        r=self.example()
        r["gates"][0]["name"]='</script><img src=x onerror="alert(1)">'
        page=render(r)
        self.assertEqual(page.count("</script>"),2) # one data element + one executable script
        self.assertNotIn('<img src=x onerror=',page)
        self.assertIn(chr(92)+"u003c",page)

    def test_does_not_include_private_details(self):
        r=self.example()
        r["measurements"]["orders"][0]["resources"]={
            "bucket":"my-internal-project","queue":"never-show-secret"
        }
        page=render(r)
        self.assertNotIn("my-internal-project",page)
        self.assertNotIn("never-show-secret",page)

    def test_no_runner_working_directory_in_html(self):
        page=render(self.example())
        self.assertNotIn("C:\\\\Users",page)
        self.assertNotIn("/mnt/c/Users",page)

if __name__=="__main__":
    unittest.main()
