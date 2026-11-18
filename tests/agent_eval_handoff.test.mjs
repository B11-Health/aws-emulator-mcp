import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {toAgentEvaluationHandoff,readBundledHandoff,handoffMarkdown} from '../scripts/agent_eval_handoff.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFileSync(path.join(ROOT,p));
const recorded=JSON.parse(read('docs/evidence/app-case-aws-emulator-1.0.506.json'));
const caseSpec=JSON.parse(read('examples/app-case/sqs-idempotency.json'));
const before=read('examples/app-case/buggy.py');
const after=read('examples/app-case/fixed.py');
const inputs=()=>({caseSpec:structuredClone(caseSpec),record:structuredClone(recorded),sourceBefore:before,sourceAfter:after});

test('frozen machine-readable artifact equals the verifier output',()=>{
  const frozen=JSON.parse(read('examples/agent-eval/sqs-idempotency-recorded.json'));
  assert.deepEqual(frozen,readBundledHandoff());
});

test('bundled evaluation captures actual independent postconditions',()=>{
  const result=readBundledHandoff();
  assert.equal(result.kind,'independent_local_agent_evaluation_handoff');
  assert.equal(result.result.localEvaluationPassed,true);
  assert.equal(result.result.negativeControlDetected,true);
  assert.equal(result.result.positiveControlVerified,true);
  assert.equal(result.result.cleanupVerifiedBoth,true);
  assert.deepEqual(result.observed.before.assertions,{passed:3,total:4});
  assert.deepEqual(result.observed.after.assertions,{passed:4,total:4});
  assert.deepEqual(result.case.expectedRegression,{stepId:'receive',path:'Messages.1'});
  assert.equal(result.emulator.version,'Version: 1.0.506');
  assert.equal(result.metadata.sourceExecutedDuringExport,false);
  assert.equal(result.metadata.awsCallsDuringExport,false);
  assert.equal(result.metadata.dockerUsedDuringExport,false);
  assert.equal(result.metadata.productionAWSValidated,false);
  assert.match(result.compatibility,/not an AWS-Bench task/);
  assert.match(handoffMarkdown(result),/Independent reference case|Application-behavior evaluation handoff/i);
});

test('source or case hash mismatch and incompatible emulator version fail closed',()=>{
  const changed=inputs(); changed.sourceBefore=Buffer.from('different selected handler');
  assert.throws(()=>toAgentEvaluationHandoff(changed),/match the exact public inputs/);
  const caseChanged=inputs();caseChanged.caseSpec.name='modified-case';
  assert.throws(()=>toAgentEvaluationHandoff(caseChanged),/match the exact public inputs/);
  const versionChanged=inputs();versionChanged.record.after.emulatorVersion='Version: other';
  assert.throws(()=>toAgentEvaluationHandoff(versionChanged),/same AWS Emulator version/);
  const missing=inputs();delete missing.record.after;
  assert.throws(()=>toAgentEvaluationHandoff(missing),/complete case/);
});

test('unexpected failure cannot be credited as the named bug regression',()=>{
  const changed=inputs();
  changed.record.before.checks[1].assertions[0].passed=false;
  changed.record.before.checks[1].assertions[1].passed=true;
  const result=toAgentEvaluationHandoff(changed);
  assert.equal(result.observed.bugReproduced,false);
  assert.equal(result.result.negativeControlDetected,false);
  assert.equal(result.result.localEvaluationPassed,false);
});

test('contradictory assertions and call counters are rejected',()=>{
  for(const mutate of [
    value=>{value.record.before.checks[1].assertions[1].passed=true},
    value=>{value.record.after.expectedCalls[0].observed=99},
    value=>{value.record.after.setup[0].responseSha256='invalid'},
    value=>{value.record.before.cleanupPassed=false},
    value=>{value.record.after.sourceInvoked=false},
  ]) {
    const input=inputs(); mutate(input);
    assert.throws(()=>toAgentEvaluationHandoff(input));
  }
});
