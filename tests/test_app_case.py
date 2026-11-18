"""One explicitly approved Python app function, independently inspected SDK state."""
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'src'))
from aws_emulator_mcp import app_case, contract_case
from aws_emulator_mcp import server as aws

SPEC=json.loads((ROOT/'examples/app-case/sqs-idempotency.json').read_text())


def envelope(source, spec=SPEC):
    return {'schemaVersion':1, 'source':source,
            'sourceSha256':hashlib.sha256(source.encode()).hexdigest(), 'case':spec}


class FakeSQS:
    class Meta:
        method_to_api_mapping={
            'create_queue':'CreateQueue', 'send_message':'SendMessage',
            'receive_message':'ReceiveMessage', 'delete_queue':'DeleteQueue'}
    meta=Meta()

    def __init__(self):
        self.messages=[]
        self.deleted=False

    def create_queue(self,QueueName):
        return {'QueueUrl':'https://localhost.test/synthetic-queue'}

    def send_message(self,QueueUrl,MessageBody):
        self.messages.append(MessageBody)
        return {'MessageId':'id-'+str(len(self.messages))}

    def receive_message(self,QueueUrl,MaxNumberOfMessages,WaitTimeSeconds):
        return {'Messages':[{'Body':v, 'ReceiptHandle':'receipt-'+str(i)}
                            for i,v in enumerate(self.messages[:MaxNumberOfMessages])]}

    def delete_queue(self,QueueUrl):
        self.deleted=True
        return {}


class FakeDynamoDB:
    class Meta:
        method_to_api_mapping={
            'create_table':'CreateTable', 'describe_table':'DescribeTable',
            'put_item':'PutItem', 'get_item':'GetItem', 'delete_table':'DeleteTable'}
    meta=Meta()

    def __init__(self):
        self.table=None
        self.item=None
        self.deleted=False

    def create_table(self,TableName,AttributeDefinitions,KeySchema,BillingMode):
        self.table=TableName
        return {'TableDescription': {'TableName':TableName}}

    def describe_table(self,TableName):
        return {'Table': {'TableStatus':'ACTIVE'}}

    def put_item(self,TableName,Item):
        self.item=Item
        return {}

    def get_item(self,TableName,Key):
        return {'Item':self.item} if self.item else {}

    def delete_table(self,TableName):
        self.deleted=True
        return {}


class AppCaseTests(unittest.TestCase):
    def test_reviewed_case_and_envelope_validation(self):
        self.assertIs(app_case.validate_case(SPEC),SPEC)
        self.assertEqual(app_case.validate_envelope(envelope('def handle(clients, inputs): pass'))['sourceSha256'],
                         envelope('def handle(clients, inputs): pass')['sourceSha256'])
        for change in [
            lambda p: p.update(extra='unexpected'),
            lambda p: p['invoke'].update(times=0),
            lambda p: p['invoke'].update(entrypoint='__import__'),
            lambda p: p['invoke'].update(expectedCalls=[]),
            lambda p: p['invoke']['inputs'].update(bad={'$ref':'later.Name'}),
            lambda p: p['checks'][0].update(fault={'mode':'before-call'}),
            lambda p: p.update(regression={'stepId':'inspect','path':'Missing.NotPresent'}),
            lambda p: p.update(services=['sqs','sqs']),
            lambda p: p.update(checks=[{**p['checks'][0], 'expect':{'assertions':[]}}]),
        ]:
            candidate=json.loads(json.dumps(SPEC))
            change(candidate)
            with self.subTest(candidate=str(candidate)[:120]), self.assertRaises((ValueError,aws.LocalError)):
                app_case.validate_case(candidate)
        bad=envelope('def handle(clients, inputs): pass')
        bad['sourceSha256']='0'*64
        with self.assertRaises(ValueError):
            app_case.validate_envelope(bad)
        with self.assertRaises(ValueError):
            app_case.validate_envelope(dict(envelope('pass'),unexpected='unsafe'))

    def test_independent_checks_detect_real_duplicate_and_keep_app_private(self):
        buggy=(ROOT/'examples/app-case/buggy.py').read_text()
        sqs,ddb=FakeSQS(),FakeDynamoDB()
        source='''def handle(clients, inputs):
    print("PRIVATE_SOURCE_VALUE")
    clients["dynamodb"].put_item(TableName=inputs["table"],Item={"id":{"S":inputs["id"]},"state":{"S":"queued"}})
    clients["sqs"].send_message(QueueUrl=inputs["queueUrl"],MessageBody=inputs["body"])
'''
        def sdk_client(name):
            return (None,None,{'sqs':sqs,'dynamodb':ddb}[name],None,None)
        with patch.dict(os.environ,{'AWS_EMULATOR_MCP_ISOLATED_LAB':'1'}), \
             patch.object(aws,'doctor',return_value={'ready':True,'emulator_version':'test-1'}), \
             patch.object(aws,'identity',return_value={'Account':'000000000000'}), \
             patch('aws_emulator_mcp.aws_sdk._client',side_effect=sdk_client), \
             patch('aws_emulator_mcp.contract_case._wait_created_table_active',return_value=1):
            report=app_case.execute(envelope(source))
        self.assertFalse(report['passed'])
        self.assertFalse(report['applicationInvariantPassed'])
        self.assertTrue(report['sourceInvoked'])
        self.assertTrue(report['cleanupPassed'])
        self.assertTrue(sqs.deleted and ddb.deleted)
        self.assertEqual(report['checks'][1]['assertions'],[
            {'path':'Messages.0.Body','passed':True},
            {'path':'Messages.1','passed':False}])
        self.assertEqual(next(c['attempts'] for c in report['sdkCalls'] if c['service']=='sqs'),2)
        payload=json.dumps(report)
        self.assertNotIn('PRIVATE_SOURCE_VALUE',payload)
        self.assertNotIn('synthetic-order-event',payload)
        self.assertNotIn('https://localhost.test',payload)
        self.assertNotIn(buggy[:40],payload)

    def test_no_source_execution_when_emulator_identity_is_unverified(self):
        source='''raise RuntimeError('NEVER_EXECUTE_THIS_APP')'''
        with patch.dict(os.environ,{'AWS_EMULATOR_MCP_ISOLATED_LAB':'1'}), \
             patch.object(aws,'doctor',return_value={'ready':True}), \
             patch.object(aws,'identity',return_value={'Account':'111122223333'}):
            with self.assertRaisesRegex(ValueError,'identity'):
                app_case.execute(envelope(source))
        with patch.dict(os.environ,{'AWS_EMULATOR_MCP_ISOLATED_LAB':'0'}):
            with self.assertRaisesRegex(ValueError,'isolated Docker'):
                app_case.execute(envelope(source))

    def test_fake_success_from_app_does_not_count_without_sdk_activity(self):
        sqs,ddb=FakeSQS(),FakeDynamoDB()
        def sdk_client(name):
            return (None,None,{'sqs':sqs,'dynamodb':ddb}[name],None,None)
        source='''def handle(clients,inputs):
    return {'passed':True,'sdkCalls':1000}
'''
        with patch.dict(os.environ,{'AWS_EMULATOR_MCP_ISOLATED_LAB':'1'}), \
             patch.object(aws,'doctor',return_value={'ready':True,'emulator_version':'test-1'}), \
             patch.object(aws,'identity',return_value={'Account':'000000000000'}), \
             patch('aws_emulator_mcp.aws_sdk._client',side_effect=sdk_client), \
             patch('aws_emulator_mcp.contract_case._wait_created_table_active',return_value=1):
            report=app_case.execute(envelope(source))
        self.assertFalse(report['passed'])
        self.assertFalse(report['applicationInvariantPassed'])
        self.assertTrue(report['cleanupPassed'])
        self.assertEqual(report['sdkCalls'],[])
        self.assertTrue(all(not expected['passed'] for expected in report['expectedCalls']))


if __name__=='__main__': unittest.main()
