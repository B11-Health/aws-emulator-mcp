import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAppCaseProof, compareAppCaseEvidence, appCaseMarkdown } from '../scripts/app_case_compare.mjs';
import { planSha256 } from '../scripts/project_check.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'bin/aws-emulator-mcp.mjs');
const recorded=JSON.parse(readFileSync(path.join(ROOT,'docs/evidence/app-case-aws-emulator-1.0.506.json'),'utf8'));
const spec=JSON.parse(readFileSync(path.join(ROOT,'examples/app-case/sqs-idempotency.json'),'utf8'));
const digest = file => createHash('sha256').update(readFileSync(path.join(ROOT,'examples/app-case',file))).digest('hex');
const beforeSha=digest('buggy.py'), afterSha=digest('fixed.py');

function compare(b=recorded.before,a=recorded.after,bs=beforeSha,as=afterSha,bc=1,ac=0){
  return compareAppCaseEvidence(b,bs,bc,a,as,ac,spec);
}

test('recorded signed-emulator app evidence proves a named before/after invariant',()=>{
  assert.equal(recorded.before.emulatorVersion,'Version: 1.0.506');
  assert.equal(planSha256(spec),recorded.before.caseSha256);
  const result=compare();
  assert.equal(result.passed,true);
  assert.equal(result.bugReproduced,true);
  assert.equal(result.fixVerified,true);
  assert.deepEqual(result.regression,{stepId:'receive',path:'Messages.1'});
  assert.equal(result.before.sdkCalls.find(x=>x.service==='sqs').attempts,2);
  assert.equal(result.after.sdkCalls.find(x=>x.service==='sqs').attempts,1);
  assert.equal(result.applicationBehaviorTested,true);
  assert.equal(result.productionAwsValidated,false);
  assert.equal(result.before.cleanupPassed,true);
  assert.equal(result.after.cleanupPassed,true);
  assert.match(appCaseMarkdown(result),/Expected regression:.*receive.Messages.1/);
  assert.doesNotMatch(appCaseMarkdown(result),/synthetic-order-event/);
});

test('false source hashes, mismatched cases, stale SDK counts and forged assertions fail closed',()=>{
  const altered=[];
  for (const mutation of [
    p=>{p.sourceSha256='0'.repeat(64)},
    p=>{p.caseSha256='0'.repeat(64)},
    p=>{p.accountVerified=false},
    p=>{p.emulatorVersion=''},
    p=>{p.expectedCalls[0].observed=123},
    p=>{p.sdkCalls[0].attempts=99},
    p=>{p.cleanupPassed=false},
    p=>{p.checks[1].assertions[1].passed=true},
    p=>{p.setup[0].responseSha256='bad'},
    p=>{p.sourceInvoked=false},
    p=>{p.applicationInvariantPassed=true},
  ]){
    const p=structuredClone(recorded.before); mutation(p);
    assert.throws(()=>compare(p,recorded.after),/evidence|mismatch|Contradictory|Malformed|invoked source/i);
  }
  assert.throws(()=>compare(recorded.before,recorded.after,beforeSha,beforeSha));
  assert.throws(()=>compare(recorded.before,recorded.after,beforeSha,afterSha,0,0));
  const wrongVersion=structuredClone(recorded.after);
  wrongVersion.emulatorVersion='Version: not-same';
  assert.throws(()=>compare(recorded.before,wrongVersion),/same AWS Emulator version/);
});

test('zero successful expected SDK calls cannot verify an application fix',()=>{
  const after=structuredClone(recorded.after);
  const sent=after.sdkCalls.find(c=>c.service==='sqs' && c.operation==='SendMessage');
  assert.ok(sent.attempts > 0);
  sent.successes=0; // Synthetic caught exception: attempt counted, API never succeeded.
  // A forged green runner report must fail closed even with passing state checks.
  assert.throws(()=>compare(recorded.before,after),/Contradictory application success/);
});

test('unrelated failure does not count as a reproduced regression',()=>{
  const before=structuredClone(recorded.before);
  // Preserve the exact record's response validity while changing the failure
  // to a different, non-regression assertion.
  before.checks[1].assertions[0].passed=false;
  before.checks[1].assertions[1].passed=true;
  assert.equal(compare(before,recorded.after).bugReproduced,false);
  assert.equal(compare(before,recorded.after).passed,false);
  const cleanup=structuredClone(recorded.before);
  cleanup.cleanup[0].passed=false;
  cleanup.cleanup[0].observed='api_error';
  cleanup.cleanup[0].errorCode='SyntheticFailure';
  delete cleanup.cleanup[0].responseSha256;
  cleanup.cleanupPassed=false;
  assert.equal(compare(cleanup,recorded.after).passed,false);
  const crashed=structuredClone(recorded.before);
  crashed.applicationErrors=true;
  assert.equal(compare(crashed,recorded.after).passed,false);
});

const retrySpec=JSON.parse(readFileSync(path.join(ROOT,'examples/app-case/sqs-retry-timeout.json'),'utf8'));
const retryRecorded=JSON.parse(readFileSync(path.join(ROOT,
  'docs/evidence/app-case-sqs-retry-aws-emulator-1.0.506.json'),'utf8'));
const retryBugSha=digest('sqs-retry-bug.py'), retryFixSha=digest('sqs-retry-fixed.py');

const latestRetryRecorded=JSON.parse(readFileSync(path.join(ROOT,
  'docs/evidence/app-case-sqs-retry-aws-emulator-1.0.508.json'),'utf8'));

test('signed local emulator 1.0.508 recorded retry and lost-ack checks remain verifiable',()=>{
  const c=latestRetryRecorded.comparison;
  assert.equal(c.emulatorVersion,'Version: 1.0.508');
  assert.equal(c.caseSha256,planSha256(retrySpec));
  assert.equal(c.before.sourceSha256,retryBugSha);
  assert.equal(c.after.sourceSha256,retryFixSha);
  assert.equal(c.passed,true);
  assert.equal(c.bugReproduced,true);
  assert.equal(c.fixVerified,true);
  assert.equal(c.productionAwsValidated,false);
  assert.equal(c.before.cleanupPassed,true);
  assert.equal(c.after.cleanupPassed,true);
  assert.equal(c.before.sdkCalls[0].successes,0);
  assert.equal(c.after.sdkCalls[0].successes,1);
  const expected=structuredClone(retrySpec);
  expected.invoke.fault.mode='after-success';
  const negative=latestRetryRecorded.afterSuccessNegativeControl;
  assert.equal(negative.appFault.injected,true);
  assert.equal(negative.appFault.sentToEmulator,true);
  assert.equal(negative.cleanupPassed,true);
  assert.equal(negative.sdkCalls[0].successes,2);
  assert.equal(negative.checks[0].assertions[1].passed,false);
  assert.equal(verifyAppCaseProof(negative,retryFixSha,expected,1).passed,false);
});

test('app fault evidence proves a Python recovery path, not a standalone SDK probe',()=>{
  const before=structuredClone(retryRecorded.before), after=structuredClone(retryRecorded.after);
  assert.equal(before.emulatorVersion,'Version: 1.0.506');
  const comparison=compareAppCaseEvidence(before,retryBugSha,1,after,retryFixSha,0,retrySpec);
  assert.equal(comparison.passed,true);
  assert.equal(comparison.bugReproduced,true);
  assert.equal(comparison.fixVerified,true);
  assert.equal(comparison.before.appFault.injected,true);
  assert.equal(comparison.after.appFault.injected,true);
  assert.equal(comparison.before.sdkCalls[0].successes,0);
  assert.equal(comparison.after.sdkCalls[0].successes,1);
  assert.match(appCaseMarkdown(comparison),/Synthetic before-call SDK fault/);
  assert.doesNotMatch(JSON.stringify(comparison),/synthetic-retry-event/);
});

test('real signed-emulator lost-ack negative control exposes duplicate SQS send',()=>{
  const spec=structuredClone(retrySpec);
  spec.invoke.fault.mode='after-success';
  const report=retryRecorded.afterSuccessNegativeControl;
  assert.equal(report.emulatorVersion,'Version: 1.0.506');
  assert.equal(report.appFault.sentToEmulator,true);
  assert.equal(report.sdkCalls[0].successes,2);
  assert.equal(report.checks[0].assertions[1].passed,false);
  assert.equal(report.cleanupPassed,true);
  assert.equal(verifyAppCaseProof(report,retryFixSha,spec,1).passed,false);
});

test('missing, forged, or untriggered app fault never produces a false green',()=>{
  const before=structuredClone(retryRecorded.before), after=structuredClone(retryRecorded.after);
  for (const mutation of [
    p=>{delete p.appFault},
    p=>{p.appFault.sentToEmulator=true},
    p=>{p.appFault.mode='after-success'},
    p=>{p.appFault.attemptsSeen=0},
    p=>{p.appFault.injected=false},
    p=>{p.appFault.privateUrl='do-not-leak'},
    p=>{p.sdkCalls[0].successes=2},
  ]) {
    const invalid=structuredClone(after); mutation(invalid);
    assert.throws(()=>verifyAppCaseProof(invalid,retryFixSha,retrySpec,0),
      /fault|SDK attempt|Missing|inconsistent/);
  }
  // An application that succeeds at its state assertions but never executes
  // the selected fault is explicitly NOT a verified recovery branch.
  const unreachable=structuredClone(after);
  unreachable.sdkCalls=[];
  unreachable.expectedCalls[0].observed=0;
  unreachable.expectedCalls[0].passed=false;
  unreachable.appFault.attemptsSeen=0;
  unreachable.appFault.injected=false;
  unreachable.applicationInvariantPassed=false;
  unreachable.passed=false;
  assert.equal(verifyAppCaseProof(unreachable,retryFixSha,retrySpec,1).passed,false);
  assert.equal(compareAppCaseEvidence(before,retryBugSha,1,
    unreachable,retryFixSha,1,retrySpec).passed,false);
  const original=structuredClone(recorded.after);
  original.appFault=structuredClone(after.appFault);
  assert.throws(()=>verifyAppCaseProof(original,afterSha,spec,0),/Unrequested/);
});

test('CLI accepts only explicit local source and bounded reviewed cases',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'mcp-app-case-cli-'));
  const run=(...args)=>spawnSync(process.execPath,[CLI,...args],{encoding:'utf8',timeout:15000});
  try{
    for(const args of [
      ['app-case','--json'],
      ['app-case','https://example.com/app.py','examples/app-case/sqs-idempotency.json','--json'],
      ['app-case-compare','examples/app-case/buggy.py','examples/app-case/buggy.py','examples/app-case/sqs-idempotency.json'],
      ['app-case-compare','foo.py','bar.py','sample.json','--json','--markdown'],
      ['app-case','examples/app-case/fixed.py','https://example.com/case.json'],
    ]){
      const response=run(...args);
      assert.notEqual(response.status,0,args.join(' '));
      assert.equal(response.stdout,'');
    }
    const module=path.join(dir,'app.py');
    writeFileSync(module,'def handle(clients, inputs): return True\n');
    const result=spawnSync(process.execPath,[CLI,'app-case',module,
      path.join(ROOT,'examples/app-case/sqs-idempotency.json'),'--json'],{
      encoding:'utf8',timeout:15000,
      env:{...process.env,DOCKER_HOST:'tcp://192.0.2.99:2375'},
    });
    assert.equal(result.status,1);
    assert.equal(result.stdout,'');
    assert.match(result.stderr,/Refusing nonlocal DOCKER_HOST/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
