import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, lstatSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseAppGuideArgs,approvalToken,summarizeAppGuide,writeDraftExclusive,requiredOperationsSucceeded} from '../scripts/app_guide.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI=path.join(ROOT,'bin/aws-emulator-mcp.mjs');
const S3=path.join(ROOT,'examples/app-case/s3-upload.py');
const CASE=path.join(ROOT,'examples/app-case/s3-object-write.json');
const originalCase=JSON.parse(readFileSync(CASE,'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
function cli(...args) {
  return spawnSync(process.execPath,[CLI,'app-guide',...args],{
    encoding:'utf8',timeout:24000,
    env:{...process.env,DOCKER_HOST:'tcp://198.51.100.21:2375',
      AWS_ACCESS_KEY_ID:'PRIVATE_KEY_SHOULD_NOT_APPEAR'}
  });
}

const inspected={sourceSha256:'a'.repeat(64),entrypoint:'handle',
  entrypointFound:true,entrypointSignatureMatches:true,
  calls:[{service:'s3',operationCandidate:'PutObject',line:5}],
  unresolvedAccesses:[],inputKeys:['bucket','data','key'],
  suggestedExamples:['examples/app-case/s3-object-write.json'],
  starterCase:{reviewRequired:true,checks:[],cleanup:[]},
  caseReview:{caseSha256:'b'.repeat(64),entrypointMatches:true,
    missingInputKeys:[],callsWithoutExpectedCounters:[],
    expectedCountersNotSeenInSyntax:[],discoveredServicesNotDeclared:[]}};

test('saved 1.0.511 local-emulator guide evidence remains tied to source and case hashes',()=>{
  const evidence=JSON.parse(readFileSync(path.join(ROOT,
    'docs/evidence/guided-app-case-aws-emulator-1.0.511.json'),'utf8'));
  assert.equal(evidence.emulatorVersion,'Version: 1.0.511');
  assert.equal(evidence.positiveControl.sourceSha256,sha(readFileSync(S3)));
  assert.equal(evidence.negativeControl.sourceSha256,sha(readFileSync(path.join(ROOT,
    'examples/app-case/s3-upload-bug.py'))));
  for (const side of ['positiveControl','negativeControl']) {
    const proof=evidence[side];
    assert.equal(proof.caseSha256,sha(readFileSync(CASE)));
    assert.equal(proof.proof.emulatorVersion,evidence.emulatorVersion);
    assert.equal(proof.proof.cleanupPassed,true);
    assert.equal(proof.productionAwsValidated,false);
    assert.equal(proof.localExecutionApproved,true);
    assert.equal(proof.successfulExpectedOperations,true);
    assert.equal(proof.proof.checks[0].assertions[0].path,'ContentLength');
  }
  assert.equal(evidence.positiveControl.passed,true);
  assert.equal(evidence.positiveControl.proof.checks[0].assertions[0].passed,true);
  assert.equal(evidence.negativeControl.passed,false);
  assert.equal(evidence.negativeControl.proof.checks[0].assertions[0].passed,false);
  assert.doesNotMatch(JSON.stringify(evidence),/AWS_SECRET_ACCESS_KEY|<trusted-local-app>|PRIVATE_KEY_SHOULD_NOT_APPEAR/);
});

test('parse flags strictly without accepting arbitrary URLs or extra arguments',()=>{
  assert.deepEqual(parseAppGuideArgs(['app.py']),{
    source:'app.py',caseFile:null,json:false,draft:null,run:false,approval:null});
  const token='f'.repeat(64);
  const parsed=parseAppGuideArgs(['--json','app.py','case.json','--run','--approve',token]);
  assert.equal(parsed.run,true);
  assert.equal(parsed.approval,token);
  assert.equal(parsed.caseFile,'case.json');
  for(const bad of [[],['--run','app.py'],['--approve',token,'app.py'],
    ['app.py','case.json','--run'],['app.py','case.json','--approve',token],
    ['app.py','--draft','draft.json','--run','--approve',token],
    ['app.py','case.json','--draft','draft.json'],
    ['https://example.org/evil.py'],['app.py','--draft','https://example.org/x.json'],
    ['app.py','--approve','BAD_HASH','--run','case.json'],
    ['app.py','case.json','--json','--json'],['app.py','case.json','--unexpected']])
    assert.throws(()=>parseAppGuideArgs(bad));
});

test('approval binds exact 64-character raw source and case hashes',()=>{
  const one=approvalToken('a'.repeat(64),'b'.repeat(64));
  assert.match(one,/^[a-f0-9]{64}$/);
  assert.notEqual(one,approvalToken('a'.repeat(64),'c'.repeat(64)));
  assert.notEqual(one,approvalToken('e'.repeat(64),'b'.repeat(64)));
  assert.throws(()=>approvalToken('BAD','b'.repeat(64)));
});

test('reviewed static match and valid case schema produce a token without executing source',()=>{
  const result=summarizeAppGuide(inspected,originalCase,{schemaValidation:{schemaVersion:1,
    valid:true,caseSha256:'b'.repeat(64),developerSourceExecuted:false,
    awsApiCallsMade:false,dockerStarted:false}});
  assert.equal(result.status,'explicit_approval_required');
  assert.equal(result.readyForApproval,true);
  assert.equal(result.approvalToken,approvalToken('a'.repeat(64),'b'.repeat(64)));
  assert.equal(result.executedSource,false);
  assert.equal(result.dockerStarted,false);
  assert.equal(result.productionAwsValidated,false);
  assert.equal(result.formalCaseSchemaValidated,true);
  assert.match(result.limitations,/offline declarative schema validation/);
});

test('incomplete case, missing assertion, unresolved calls and missing SDK counters fail closed',()=>{
  for(const altered of [
    {...originalCase,reviewRequired:true},
    {...originalCase,checks:[]},
    {...originalCase,cleanup:[]},
    {...originalCase,regression:{stepId:'wrong',path:'ContentLength'}},
    {...originalCase,invoke:{...originalCase.invoke,
      inputs:{...originalCase.invoke.inputs,key:'REVIEW_ME'}}},
    {...originalCase,invoke:{...originalCase.invoke,expectedCalls:[]}},
  ]) {
    const result=summarizeAppGuide(inspected,altered);
    assert.equal(result.readyForApproval,false);
    assert.equal(result.approvalToken,null);
    assert.ok(result.reviewGaps.length>0);
  }
  const dynamic=summarizeAppGuide({...inspected,unresolvedAccesses:[{line:4,reason:'dynamic'}]},originalCase);
  assert.equal(dynamic.readyForApproval,false);
  const missing=summarizeAppGuide({...inspected,caseReview:{...inspected.caseReview,
    callsWithoutExpectedCounters:[{service:'s3',operationCandidate:'PutObject'}]}},originalCase);
  assert.equal(missing.readyForApproval,false);
});

test('expected SDK attempts without successful writes cannot produce a green app proof',()=>{
  const spec={invoke:{expectedCalls:[{service:'sqs',operation:'SendMessage',min:1,max:2}]}};
  const caughtError={sdkCalls:[{service:'sqs',operation:'SendMessage',attempts:1,successes:0}]};
  assert.equal(requiredOperationsSucceeded(caughtError,spec),false);
  assert.equal(requiredOperationsSucceeded({sdkCalls:[{service:'sqs',operation:'SendMessage',attempts:2,successes:1}]},spec),true);
  assert.equal(requiredOperationsSucceeded({sdkCalls:[{service:'sqs',operation:'SendMessage',attempts:1,successes:2}]},spec),false);
  assert.equal(requiredOperationsSucceeded({sdkCalls:[]},spec),false);
  assert.equal(requiredOperationsSucceeded(caughtError,{}),false);
});

test('draft is visibly incomplete, create-only, bounded and never overwrites files',()=>{
  const d=mkdtempSync(path.join(tmpdir(),'aws-app-guide-draft-'));
  try {
    const filename=path.join(d,'draft.json');
    const starter={schemaVersion:1,reviewRequired:true,setup:[],checks:[],cleanup:[],
      invoke:{inputs:{key:'REPLACE_WITH_SYNTHETIC_VALUE'}}};
    const written=writeDraftExclusive(filename,starter);
    assert.equal(written.draftWritten,true);
    assert.equal(written.executable,false);
    assert.equal(JSON.parse(readFileSync(filename,'utf8')).reviewRequired,true);
    assert.throws(()=>writeDraftExclusive(filename,starter),/EEXIST/);
    assert.deepEqual(JSON.parse(readFileSync(filename,'utf8')),starter);
    const link=path.join(d,'existing.json');
    if(process.platform!=='win32') {
      symlinkSync(filename,link);
      assert.throws(()=>writeDraftExclusive(link,starter));
    }
    assert.throws(()=>writeDraftExclusive(path.join(d,'bad.txt'),starter));
  } finally {rmSync(d,{recursive:true,force:true});}
});

test('no-Docker inspect returns real source/case hashes and an explicit token',()=>{
  const r=cli(S3,CASE,'--json');
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stderr,'');
  const review=JSON.parse(r.stdout);
  assert.equal(review.sourceSha256,sha(readFileSync(S3)));
  assert.equal(review.caseSha256,sha(readFileSync(CASE)));
  assert.equal(review.status,'explicit_approval_required');
  assert.equal(review.readyForApproval,true);
  assert.equal(review.formalCaseSchemaValidated,true);
  assert.equal(review.approvalToken,approvalToken(review.sourceSha256,review.caseSha256));
  assert.deepEqual(review.operationCandidates.map(x=>x.service+'.'+x.operation),['s3.PutObject']);
  assert.equal(review.executedSource,false);
  assert.equal(review.executedAWSCalls,false);
  assert.doesNotMatch(r.stdout,/PRIVATE_KEY_SHOULD_NOT_APPEAR|198\.51\.100\.21/);
});

test('formal schema validation rejects invalid SDK call counters before approval',()=>{
  const d=mkdtempSync(path.join(tmpdir(),'aws-app-guide-formal-'));
  try {
    const invalid=path.join(d,'invalid.json');
    const malformed={...originalCase,invoke:{...originalCase.invoke,
      expectedCalls:[{service:'s3',operation:'PutObject',min:0,max:1}]}};
    writeFileSync(invalid,JSON.stringify(malformed));
    const r=cli(S3,invalid,'--json');
    assert.equal(r.status,0,r.stderr);
    const result=JSON.parse(r.stdout);
    assert.equal(result.status,'review_required');
    assert.equal(result.readyForApproval,false);
    assert.equal(result.formalCaseSchemaValidated,false);
    assert.ok(result.reviewGaps.includes('formal_case_schema_not_validated'));
    assert.equal(result.approvalToken,null);
    assert.equal(result.executedSource,false);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('draft with missing checks and cleanup cannot be approved for local execution',()=>{
  const d=mkdtempSync(path.join(tmpdir(),'aws-app-guide-draft-reject-'));
  try {
    const file=path.join(d,'review.json');
    const selected=cli(S3,'--draft',file,'--json');
    assert.equal(selected.status,0,selected.stderr);
    const result=cli(S3,file,'--json');
    // app-guide allows an incomplete review to be shown, never executed.
    assert.equal(result.status,0,result.stderr);
    const inspect=JSON.parse(result.stdout);
    assert.equal(inspect.readyForApproval,false);
    assert.equal(inspect.approvalToken,null);
    assert.ok(inspect.reviewGaps.includes('formal_case_schema_not_validated'));
    const prohibited=cli(S3,file,'--run','--approve','1'.repeat(64));
    assert.equal(prohibited.status,2);
    assert.match(prohibited.stderr,/token mismatch|Review gaps/);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('no-case draft command never executes hostile top-level Python',()=>{
  const d=mkdtempSync(path.join(tmpdir(),'aws-app-guide-noexec-'));
  try {
    const file=path.join(d,'unsafe.py'), marker=path.join(d,'EXECUTED');
    const draft=path.join(d,'draft.json');
    writeFileSync(file,`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('BAD')\ndef handle(clients, inputs):\n    clients['sqs'].send_message(QueueUrl=inputs['url'], MessageBody='hello')\n`);
    const out=cli(file,'--draft',draft,'--json');
    assert.equal(out.status,0,out.stderr);
    assert.equal(JSON.parse(out.stdout).draftWritten,true);
    assert.equal(existsSync(marker),false);
    assert.equal(JSON.parse(readFileSync(draft,'utf8')).reviewRequired,true);
    assert.equal(JSON.parse(readFileSync(draft,'utf8')).checks.length,0);
    const second=cli(file,'--draft',draft);
    assert.equal(second.status,2);
    assert.equal(existsSync(marker),false);
  } finally {rmSync(d,{recursive:true,force:true});}
});

test('approval is required before any Docker access or source execution',()=>{
  const read=JSON.parse(cli(S3,CASE,'--json').stdout);
  const noToken=cli(S3,CASE,'--run','--json');
  assert.equal(noToken.status,2);
  assert.match(noToken.stderr,/Usage/);
  const wrong=cli(S3,CASE,'--run','--approve','0'.repeat(64),'--json');
  assert.equal(wrong.status,2);
  assert.match(wrong.stderr,/token mismatch/);
  const trusted=cli(S3,CASE,'--run','--approve',read.approvalToken,'--json');
  // Remote DOCKER_HOST must be rejected BEFORE even trying Docker builds or
  // starting the selected source. Correct token is not permission to use cloud.
  assert.equal(trusted.status,1);
  assert.match(trusted.stderr,/Refusing nonlocal DOCKER_HOST/);
  assert.equal(trusted.stdout,'');
  assert.doesNotMatch(trusted.stderr,/198\.51\.100\.21|PRIVATE_KEY_SHOULD_NOT_APPEAR/);
});

test('case edits invalidate previously computed approval even if syntax still matches',()=>{
  const d=mkdtempSync(path.join(tmpdir(),'aws-app-guide-case-change-'));
  try {
    const changed=path.join(d,'case.json');
    writeFileSync(changed,readFileSync(CASE));
    const first=JSON.parse(cli(S3,changed,'--json').stdout);
    const updated={...originalCase,name:'different-but-syntactically-valid'};
    writeFileSync(changed,JSON.stringify(updated));
    const stale=cli(S3,changed,'--run','--approve',first.approvalToken);
    assert.equal(stale.status,2);
    assert.match(stale.stderr,/token mismatch/);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('failed static match with dynamic SDK access provides gaps and never approval',()=>{
  const d=mkdtempSync(path.join(tmpdir(),'aws-app-guide-unknown-'));
  try {
    const file=path.join(d,'dynamic.py');
    writeFileSync(file,'def handle(clients, inputs):\n    name = inputs["service"]\n    clients[name].send_message(QueueUrl=inputs["queueUrl"],MessageBody="v")\n');
    const r=cli(file,'--json');
    assert.equal(r.status,0,r.stderr);
    const report=JSON.parse(r.stdout);
    assert.equal(report.readyForApproval,false);
    assert.equal(report.approvalToken,null);
    assert.ok(report.reviewGaps.includes('unresolved_client_or_input_access'));
  }finally{rmSync(d,{recursive:true,force:true});}
});
