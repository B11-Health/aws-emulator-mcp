"""Prove AST onboarding is read-only, conservative and review-required."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
from aws_emulator_mcp import app_case_inspect


class AppCaseInspectionTests(unittest.TestCase):
    def test_sqs_example_maps_real_entrypoint_and_reviewed_case(self):
        file = ROOT / 'examples/app-case/fixed.py'
        case = ROOT / 'examples/app-case/sqs-idempotency.json'
        report = app_case_inspect.inspect_source(file.read_bytes())
        report = app_case_inspect.review_case(report, case.read_bytes())
        self.assertEqual(report['sourceSha256'], hashlib.sha256(file.read_bytes()).hexdigest())
        self.assertEqual([(v['service'], v['operationCandidate']) for v in report['calls']],
                         [('dynamodb', 'PutItem'), ('sqs', 'SendMessage')])
        self.assertEqual(report['inputKeys'], ['body', 'id', 'queueUrl', 'table'])
        self.assertTrue(report['entrypointSignatureMatches'])
        self.assertTrue(report['caseReview']['entrypointMatches'])
        for key in ('missingInputKeys','callsWithoutExpectedCounters',
                    'expectedCountersNotSeenInSyntax','discoveredServicesNotDeclared'):
            self.assertEqual(report['caseReview'][key], [])
        self.assertFalse(report['executedSource'] or report['executedAWSCalls'])
        self.assertFalse(report['caseReadyToRun'])
        self.assertTrue(report['starterCase']['reviewRequired'])
        self.assertEqual(report['starterCase']['checks'], [])
        self.assertEqual(report['starterCase']['setup'], [])
        self.assertIn('examples/app-case/sqs-idempotency.json', report['suggestedExamples'])
        # No premature claim of a real app test from a syntax-only report.
        self.assertNotIn('passed', report)

    def test_s3_example_catches_missing_counter_and_input(self):
        file=ROOT/'examples/app-case/s3-upload.py'
        report=app_case_inspect.inspect_source(file.read_bytes())
        self.assertEqual(report['inputKeys'],['bucket','data','key'])
        self.assertEqual(report['calls'][0]['operationCandidate'],'PutObject')
        self.assertIn('examples/app-case/s3-object-write.json',report['suggestedExamples'])
        spec=json.loads((ROOT/'examples/app-case/s3-object-write.json').read_text())
        spec['invoke']['inputs'].pop('data')
        spec['invoke']['expectedCalls']=[{'service':'s3','operation':'GetObject','min':1,'max':1}]
        review=app_case_inspect.review_case(report,json.dumps(spec).encode())['caseReview']
        self.assertEqual(review['missingInputKeys'],['data'])
        self.assertEqual(review['callsWithoutExpectedCounters'],
                         [{'service':'s3','operationCandidate':'PutObject'}])
        self.assertEqual(review['expectedCountersNotSeenInSyntax'],
                         [{'service':'s3','operation':'GetObject'}])
        self.assertFalse(review['formalSchemaValidated'])

    def test_top_level_side_effect_never_executes(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker=Path(tmp)/'PWNED_BY_SOURCE'
            code=(f"from pathlib import Path\nPath({str(marker)!r}).write_text('bad')\n"
                  "raise RuntimeError('DO NOT IMPORT THIS')\n"
                  "def handle(clients, inputs):\n"
                  "  clients['sqs'].send_message(QueueUrl=inputs['url'], MessageBody='synthetic')\n")
            file=Path(tmp)/'potentially-unsafe.py'
            file.write_text(code)
            report=app_case_inspect.inspect_source(app_case_inspect._read(str(file), '.py',20*1024))
            self.assertEqual(report['calls'][0]['operationCandidate'],'SendMessage')
            self.assertFalse(marker.exists(), 'Reading AST must not execute selected application')

    def test_nested_and_dynamic_calls_are_not_inferred(self):
        source=b'''def handle(clients, inputs):
    key = inputs.get('key')
    clients[inputs['service']].put_object(Body='unresolved')
    def helper():
        clients['s3'].delete_object(Bucket='NOT_REACHED')
    return key
'''
        result=app_case_inspect.inspect_source(source)
        self.assertEqual(result['calls'],[])
        self.assertIsNone(result['starterCase'])
        self.assertEqual(result['inputKeys'],['key','service'])
        self.assertTrue(result['unresolvedAccesses'])

    def test_client_alias_warns_without_claiming_sdk_coverage(self):
        source=b'''def handle(clients, inputs):
    s3 = clients["s3"]
    s3.put_object(Bucket=inputs["bucket"], Key=inputs["key"], Body="synthetic")
'''
        report=app_case_inspect.inspect_source(source)
        self.assertEqual(report['calls'], [])
        self.assertEqual(report['inputKeys'], ['bucket', 'key'])
        self.assertIn('client_reference_not_direct_call',
                      [x['reason'] for x in report['unresolvedAccesses']])
        self.assertFalse(report['caseReadyToRun'])

    def test_case_selected_entrypoint_is_not_assumed_handle(self):
        import os
        with tempfile.TemporaryDirectory() as folder:
            module=Path(folder)/'worker.py'
            module.write_text('''def process_event(clients, inputs):
    clients['sqs'].send_message(QueueUrl=inputs['queueUrl'], MessageBody='synthetic')
''')
            case=json.loads((ROOT/'examples/app-case/s3-object-write.json').read_text())
            case['invoke']['entrypoint']='process_event'
            case_file=Path(folder)/'case.json'
            case_file.write_text(json.dumps(case))
            script=ROOT/'src/aws_emulator_mcp/app_case_inspect.py'
            cmd=[sys.executable,'-I','-B',str(script),str(module),str(case_file),'--json']
            run=subprocess.run(cmd,text=True,capture_output=True,timeout=10,
                               env={**os.environ,'DOCKER_HOST':'tcp://192.0.2.10:2375'})
            self.assertEqual(run.returncode,0,run.stderr)
            report=json.loads(run.stdout)
            self.assertEqual(report['entrypoint'],'process_event')
            self.assertTrue(report['entrypointSignatureMatches'])
            self.assertTrue(report['caseReview']['entrypointMatches'])
            self.assertEqual(report['calls'][0]['operationCandidate'],'SendMessage')

    def test_signature_and_syntax_are_conservative(self):
        cases=[(b'print(123)',False),(b'def handle(a,b): pass',False),
               (b'async def handle(clients,inputs): pass',False),
               (b'def handle(clients,inputs): return 1',True)]
        for raw,eligible in cases:
            with self.subTest(raw=raw):
                self.assertEqual(app_case_inspect.inspect_source(raw)['entrypointSignatureMatches'], eligible)
        with self.assertRaisesRegex(app_case_inspect.SelectionError,'invalid syntax on line'):
            app_case_inspect.inspect_source(b'def handle(\n secret = 7')
        with self.assertRaisesRegex(app_case_inspect.SelectionError,'valid UTF-8'):
            app_case_inspect.inspect_source(b'\xff')
        with self.assertRaisesRegex(app_case_inspect.SelectionError,'public Python identifier'):
            app_case_inspect.inspect_source(b'pass','__secret')
        with self.assertRaisesRegex(app_case_inspect.SelectionError,'NUL'):
            app_case_inspect.inspect_source(b'print("x")\x00')

    def test_reject_urls_symlinks_large_files_and_nonstandard_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)
            f=path/'a.py'; f.write_text('def handle(clients,inputs): return True')
            self.assertEqual(app_case_inspect._read(str(f),'.py',20*1024),f.read_bytes())
            for selector in ('https://evil.example/a.py','-x'):
                with self.assertRaises(app_case_inspect.SelectionError):
                    app_case_inspect._read(selector,'.py',20*1024)
            link=path/'link.py'
            try: link.symlink_to(f)
            except OSError: pass  # Windows users may not have symlink privileges.
            else:
                with self.assertRaises(app_case_inspect.SelectionError):
                    app_case_inspect._read(str(link),'.py',20*1024)
            f.write_bytes(b'A'*21000)
            with self.assertRaises(app_case_inspect.SelectionError):
                app_case_inspect._read(str(f),'.py',20*1024-10)
        for raw in (b'NaN', b'{"invoke":NaN}', b'{"invoke":"not an object"}', b'{"invoke":{}}'):
            with self.subTest(raw=raw), self.assertRaises(app_case_inspect.SelectionError):
                app_case_inspect.review_case(app_case_inspect.inspect_source(
                    b'def handle(clients,inputs): pass'),raw)

    def test_recorded_s3_before_after_has_bound_source_hashes_and_cleanup(self):
        recorded=json.loads((ROOT/'docs/evidence/app-case-s3-aws-emulator-1.0.506.json').read_text())
        proof=recorded['comparison']
        self.assertEqual(proof['emulatorVersion'],'Version: 1.0.506')
        self.assertTrue(proof['passed'] and proof['bugReproduced'] and proof['fixVerified'])
        self.assertEqual(proof['regression'],{'stepId':'head','path':'ContentLength'})
        for mode,source in (('before','s3-upload-bug.py'),('after','s3-upload.py')):
            raw=(ROOT/'examples/app-case'/source).read_bytes().replace(b'\r\n',b'\n')
            self.assertEqual(proof[mode]['sourceSha256'],hashlib.sha256(raw).hexdigest())
            self.assertTrue(proof[mode]['cleanupPassed'])
            self.assertEqual(proof[mode]['sdkCalls'][0]['operation'],'PutObject')
            self.assertEqual(proof[mode]['sdkCalls'][0]['attempts'],1)
        s=json.dumps(proof)
        self.assertNotIn('synthetic-v1',s)
        self.assertNotIn('/tmp/aws-mcp-',s)
        self.assertFalse(proof['productionAwsValidated'])

    def test_cli_inspection_does_not_need_docker_or_write_source(self):
        import os
        file=ROOT/'examples/app-case/s3-upload.py'
        case=ROOT/'examples/app-case/s3-object-write.json'
        before=file.read_bytes()
        command=[sys.executable,'-I','-B',str(ROOT/'src/aws_emulator_mcp/app_case_inspect.py'),
                 str(file),str(case),'--json']
        env={**os.environ,'DOCKER_HOST':'tcp://192.0.2.10:2375',
             'AWS_ACCESS_KEY_ID':'NOT_A_REAL_KEY'}
        run=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                           text=True,timeout=10,env=env)
        self.assertEqual(run.returncode,0,run.stderr)
        report=json.loads(run.stdout)
        self.assertTrue(report['caseReview']['entrypointMatches'])
        self.assertFalse(report['executedAWSCalls'])
        self.assertEqual(file.read_bytes(),before)
        self.assertNotIn('NOT_A_REAL_KEY',run.stdout)


if __name__ == '__main__':
    unittest.main()
