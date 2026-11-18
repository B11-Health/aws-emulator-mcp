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
