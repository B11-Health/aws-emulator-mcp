import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {capabilityTruth,formatCapabilityTruth} from '../scripts/capability_truth.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BIN=path.join(ROOT,'bin/aws-emulator-mcp.mjs');
const sha=value=>createHash('sha256').update(value).digest('hex');
function alteredEvidence(target,change){
  const abs=path.join(ROOT,target);
  return {root:ROOT,read:file=>{
    const actual=readFileSync(file);
    if(file!==abs) return actual;
    const parsed=JSON.parse(actual);
    change(parsed);
    return Buffer.from(JSON.stringify(parsed));
  }};
}

// Never need a running emulator, AWS keys, Docker or imported user source.
test('20 named read-only probes are historical responses, not service-wide SDK proof',()=>{
  for(const key of ['sts.GetCallerIdentity','s3.ListBuckets','lambda.ListFunctions',
    'cloudformation.ListStacks','bedrock.ListFoundationModels']){
    const report=capabilityTruth(key);
    assert.equal(report.signedEmulatorProbe.status,'recorded_responded');
    assert.equal(report.signedEmulatorProbe.emulatorVersion,'Version: 1.0.343');
    assert.equal(report.sdkModel.status,'UNKNOWN');
    assert.equal(report.sdkModel.historicalSdkUseObserved,true);
    assert.equal(report.sdkModel.historicalStatus,'modeled_at_recorded_test_time');
    assert.equal(report.appProof.status,'UNKNOWN');
    assert.ok(report.unknowns.includes('FULL_EMULATOR_OPERATION_BEHAVIOR_UNKNOWN'));
    for(const provenance of report.sources) {
      assert.equal(provenance.sha256,sha(readFileSync(path.join(ROOT,provenance.path))));
    }
  }
});

test('raw source-bound SQS app comparison proves only its named historical regression',()=>{
  const report=capabilityTruth('sqs.SendMessage');
  assert.equal(report.signedEmulatorProbe.status,'UNKNOWN');
  assert.equal(report.sdkModel.status,'UNKNOWN');
  assert.equal(report.sdkModel.historicalStatus,'modeled_at_recorded_test_time');
  assert.equal(report.appProof.status,'verified_recorded_app_case');
  assert.equal(report.appProof.role,'application_sdk_write');
  assert.equal(report.appProof.emulatorVersion,'Version: 1.0.506');
  assert.equal(report.appProof.afterSuccessfulCalls,1);
  assert.equal(report.appProof.bugReproduced,true);
  assert.equal(report.appProof.fixVerified,true);
  assert.equal(report.appProof.cleanupPassedBoth,true);
  assert.equal(report.appProof.namedRegression,'receive.Messages.1');
  assert.equal(report.sources.some(x=>x.path.endsWith('/fixed.py') && x.sha256===report.appProof.afterSourceSha256),true);
  assert.doesNotMatch(JSON.stringify(report),/synthetic-order-event|AWS_SECRET_ACCESS_KEY/);
});

test('an independently checked GetItem is not mislabeled as a handler write',()=>{
  const report=capabilityTruth('dynamodb.GetItem');
  assert.equal(report.appProof.status,'verified_recorded_app_case');
  assert.equal(report.appProof.role,'independent_postcondition_read');
  assert.deepEqual(report.appProof.assertionIds,['inspect']);
  const write=capabilityTruth('dynamodb.PutItem');
  assert.equal(write.appProof.role,'application_sdk_write');
  assert.equal(write.appProof.afterSuccessfulCalls,1);
});

test('unprobed operations are explicitly UNKNOWN even in an historically probed service',()=>{
  for(const op of ['lambda.Invoke','ec2.RunInstances','s3.PutObject','nonesuch.FakeOperation']) {
    const report=capabilityTruth(op);
    assert.equal(report.sdkModel.status,'UNKNOWN');
    assert.equal(report.sdkModel.historicalSdkUseObserved,false);
    assert.equal(report.sdkModel.historicalStatus,'UNKNOWN');
    assert.equal(report.signedEmulatorProbe.status,'UNKNOWN');
    assert.equal(report.appProof.status,'UNKNOWN');
    assert.ok(report.unknowns.includes('NO_RECORDED_FIXED_READ_ONLY_PROBE'));
    assert.ok(report.unknowns.includes('NO_REVERIFIED_APP_POSTCONDITION'));
    assert.match(formatCapabilityTruth(report),/UNKNOWN/);
  }
});

test('fabricated responded results cannot become credited evidence, even with consistent totals',()=>{
  const fake=alteredEvidence('docs/evidence/coverage-aws-emulator-1.0.343.json',json=>{
    const row=json.results.find(x=>x.service==='lambda');
    row.operation='Invoke'; // Still 20/20 and a syntactically valid operation.
  });
  assert.throws(()=>capabilityTruth('lambda.Invoke',fake),/missing, changed or inconsistent/);
  const forged=alteredEvidence('docs/evidence/coverage-aws-emulator-1.0.343.json',json=>{
    json.results[0].status='api_error';json.successfulProbes=19;
  });
  assert.throws(()=>capabilityTruth('sts.GetCallerIdentity',forged),/missing, changed or inconsistent/);
});

test('forged green app assertions or cleanup never earn app proof',()=>{
  const bad=alteredEvidence('docs/evidence/app-case-aws-emulator-1.0.506.json',json=>{
    json.after.cleanup[0].passed=false;
  });
  assert.throws(()=>capabilityTruth('sqs.SendMessage',bad),/missing, changed or inconsistent/);
  const changed=alteredEvidence('docs/evidence/app-case-aws-emulator-1.0.506.json',json=>{
    json.before.checks[1].assertions[1].passed=true;
    json.comparison.passed=true;
  });
  assert.throws(()=>capabilityTruth('sqs.SendMessage',changed),/missing, changed or inconsistent/);
  const pathToFile=path.join(ROOT,'examples/app-case/fixed.py');
  assert.throws(()=>capabilityTruth('sqs.SendMessage',{root:ROOT,read:file=>
    file===pathToFile ? Buffer.from('def handle(*args): pass') : readFileSync(file)
  }),/missing, changed or inconsistent/);
});

test('authoritative allowlist modifications and missing evidence fail closed',()=>{
  const manifest=path.join(ROOT,'src/aws_emulator_mcp/aws_sdk.py');
  assert.throws(()=>capabilityTruth('sts.GetCallerIdentity',{root:ROOT,read:file=>
    file===manifest ? Buffer.from('READ_ONLY_PROBES = (("sts", "FakePass"),)') : readFileSync(file)
  }),/missing, changed or inconsistent/);
  const missing=path.join(ROOT,'docs/evidence/coverage-aws-emulator-1.0.343.json');
  assert.throws(()=>capabilityTruth('sts.GetCallerIdentity',{root:ROOT,read:file=>{
    if(file===missing)throw Error('fake private path MUST NEVER APPEAR');
    return readFileSync(file);
  }}),/missing, changed or inconsistent/);
});

test('command rejects invalid identifiers and cannot be influenced by remote Docker/AWS environment',()=>{
  const args={encoding:'utf8',timeout:9000,env:{...process.env,
    DOCKER_HOST:'tcp://198.51.100.77:2375',AWS_SECRET_ACCESS_KEY:'FAKE_SECRET_DO_NOT_PRINT',
    AWS_PROFILE:'production'}};
  const good=spawnSync(process.execPath,[BIN,'capability','lambda.Invoke','--json'],args);
  assert.equal(good.status,0,good.stderr);
  const value=JSON.parse(good.stdout);
  assert.equal(value.appProof.status,'UNKNOWN');
  assert.equal(value.signedEmulatorProbe.status,'UNKNOWN');
  assert.doesNotMatch(good.stdout+good.stderr,/198\.51\.100\.77|FAKE_SECRET_DO_NOT_PRINT|AWS_PROFILE/);
  const bads=[[],['s3'],['S3.ListBuckets'],['s3.ListBuckets','--bogus'],
    ['lambda.Invoke','--json','--json'],['https://example.org/probe']];
  for(const bad of bads){
    const out=spawnSync(process.execPath,[BIN,'capability',...bad],args);
    assert.equal(out.status,2,bad.join(' '));
    assert.equal(out.stdout,'');
    assert.doesNotMatch(out.stderr,/198\.51\.100\.77|FAKE_SECRET_DO_NOT_PRINT/);
  }
});
