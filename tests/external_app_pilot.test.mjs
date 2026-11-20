/** Read-only external-workspace pilot. No Docker, network or Python imports. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,
  writeFileSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {approvalToken} from '../scripts/app_guide.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'bin/aws-emulator-mcp.mjs');
const FIXTURE=path.join(ROOT,'examples/external-app-pilot');
const SHA=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const PILOT_ENV={...process.env,
  DOCKER_HOST:'tcp://192.0.2.77:2375',
  AWS_ACCESS_KEY_ID:'SYNTHETIC_PILOT_ONLY_DO_NOT_ECHO',
  AWS_SECRET_ACCESS_KEY:'SYNTHETIC_PILOT_SECRET_DO_NOT_ECHO'};

function pythonAvailable(){
  const cmds=process.platform==='win32'?[['py','-3'],['python']]:
    [['python3.12'],['python3.11'],['python3.10'],['python3']];
  for(const [command,...args] of cmds){
    const result=spawnSync(command,[...args,'--version'],{encoding:'utf8',timeout:3000});
    const match=/Python (\d+)\.(\d+)/.exec(result.stdout+result.stderr);
    if(result.status===0 && match && (Number(match[1])>3 ||
       (Number(match[1])===3&&Number(match[2])>=10)))return true;
  }
  return false;
}
const needsPython=!pythonAvailable();

function stageOwnedCopies(callback){
  // Sibling OUTSIDE the checkout, not a temp folder nested in this repo.
  const workspace=mkdtempSync(path.join(path.dirname(ROOT),'external receipt pilot with spaces '));
  const beforeDir=path.join(workspace,'before');
  const afterDir=path.join(workspace,'after');
  mkdirSync(beforeDir);mkdirSync(afterDir);
  const stage={workspace,before:path.join(beforeDir,'receipt_handler.py'),
    after:path.join(afterDir,'receipt_handler.py'),
    caseFile:path.join(workspace,'receipt-case.json')};
  try{
    copyFileSync(path.join(FIXTURE,'before/receipt_handler.py'),stage.before);
    copyFileSync(path.join(FIXTURE,'after/receipt_handler.py'),stage.after);
    copyFileSync(path.join(FIXTURE,'receipt-case.json'),stage.caseFile);
    assert.equal(SHA(stage.before),SHA(path.join(FIXTURE,'before/receipt_handler.py')));
    assert.equal(SHA(stage.after),SHA(path.join(FIXTURE,'after/receipt_handler.py')));
    assert.equal(SHA(stage.caseFile),SHA(path.join(FIXTURE,'receipt-case.json')));
    assert.equal(path.isAbsolute(workspace),true);
    assert.ok(workspace.includes(' '),'external stage must contain spaces');
    assert.ok(path.relative(ROOT,workspace).startsWith('..'),
      'stage MUST be outside the MCP checkout');
    return callback(stage);
  }finally{rmSync(workspace,{recursive:true,force:true});}
}

function invoke(stage,args,extraEnv={}){
  return spawnSync(process.execPath,[CLI,...args],{cwd:stage.workspace,
    encoding:'utf8',timeout:20000,
    env:{...PILOT_ENV,...extraEnv}});
}
const parseOutput=result=>{
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stderr,'');
  assert.doesNotMatch(result.stdout,/SYNTHETIC_PILOT_ONLY_DO_NOT_ECHO|SYNTHETIC_PILOT_SECRET_DO_NOT_ECHO/);
  return JSON.parse(result.stdout);
};

test('maintained case makes Unicode byte-loss an independent S3 state regression',()=>{
  const data=JSON.parse(readFileSync(path.join(FIXTURE,'receipt-case.json'),'utf8'));
  const before=readFileSync(path.join(FIXTURE,'before/receipt_handler.py'),'utf8');
  const after=readFileSync(path.join(FIXTURE,'after/receipt_handler.py'),'utf8');
  const receipt=data.invoke.inputs.receipt;
  const utf8Bytes=Buffer.byteLength(receipt,'utf8');
  const asciiIgnoreBytes=[...receipt].filter(character=>character.codePointAt(0)<128).length;
  assert.equal(utf8Bytes,48);
  assert.equal(asciiIgnoreBytes,43);
  assert.notEqual(utf8Bytes,asciiIgnoreBytes,'bug must be observable');
  assert.match(before,/Body=inputs\["receipt"\]\.encode\("ascii", "ignore"\)/);
  assert.match(after,/Body=inputs\["receipt"\]\.encode\("utf-8"\)/);
  assert.notEqual(SHA(path.join(FIXTURE,'before/receipt_handler.py')),
    SHA(path.join(FIXTURE,'after/receipt_handler.py')));
  assert.deepEqual(data.services,['s3']);
  assert.deepEqual(data.invoke.expectedCalls,[{service:'s3',operation:'PutObject',min:1,max:1}]);
  assert.equal(data.invoke.times,1);
  assert.deepEqual(data.setup.map(s=>s.operation),['CreateBucket']);
  assert.deepEqual(data.setup[0].parameters.Bucket,{$fixture:'bucket'});
  assert.deepEqual(data.invoke.inputs.bucket,{$fixture:'bucket'});
  assert.deepEqual(data.invoke.inputs.key,{$fixture:'id'});
  assert.deepEqual(data.checks.map(s=>s.operation),['HeadObject']);
  const stateRead=data.checks[0];
  assert.deepEqual(stateRead.parameters.Bucket,{$fixture:'bucket'});
  assert.deepEqual(stateRead.parameters.Key,{$fixture:'id'});
  assert.deepEqual(stateRead.expect.assertions,[{path:'ContentLength',equals:utf8Bytes}]);
  assert.equal(asciiIgnoreBytes===stateRead.expect.assertions[0].equals,false);
  assert.equal(utf8Bytes===stateRead.expect.assertions[0].equals,true);
  assert.deepEqual(data.regression,{stepId:'head-receipt',path:'ContentLength'});
  assert.deepEqual(data.cleanup.map(s=>s.operation),['DeleteObject','DeleteBucket']);
  assert.deepEqual(data.cleanup[0].parameters.Key,{$fixture:'id'});
  assert.deepEqual(data.cleanup.map(s=>s.parameters.Bucket),
    [{$fixture:'bucket'},{$fixture:'bucket'}]);
});

test('absolute external paths with spaces inspect both sources and the SAME reviewed case',
 {skip:needsPython},()=>stageOwnedCopies(stage=>{
   const records=[];
   for(const side of ['before','after']){
     const response=invoke(stage,['app-case-inspect',stage[side],stage.caseFile,'--json']);
     const report=parseOutput(response);
     assert.equal(report.mode,'static_app_case_inspection');
     assert.equal(report.sourceSha256,SHA(stage[side]));
     assert.equal(report.caseReview.caseSha256,SHA(stage.caseFile));
     assert.equal(report.entrypoint,'handle');
     assert.equal(report.entrypointFound,true);
     assert.equal(report.entrypointSignatureMatches,true);
     assert.deepEqual(report.inputKeys,['bucket','key','receipt']);
     assert.deepEqual(report.calls.map(call=>call.service+'.'+call.operationCandidate),
       ['s3.PutObject']);
     assert.deepEqual(report.unresolvedAccesses,[]);
     assert.deepEqual(report.caseReview.missingInputKeys,[]);
     assert.deepEqual(report.caseReview.callsWithoutExpectedCounters,[]);
     assert.deepEqual(report.caseReview.expectedCountersNotSeenInSyntax,[]);
     assert.deepEqual(report.caseReview.discoveredServicesNotDeclared,[]);
     assert.equal(report.executedSource,false);
     assert.equal(report.executedAWSCalls,false);
     assert.equal(report.caseReadyToRun,false,
       'AST report is not a real application execution approval');
     records.push(report);
   }
   assert.notEqual(records[0].sourceSha256,records[1].sourceSha256);
   assert.equal(records[0].caseReview.caseSha256,records[1].caseReview.caseSha256);
 }));

test('app-guide statically approves separately hashed staged sources with zero execution',
 {skip:needsPython},()=>stageOwnedCopies(stage=>{
   const proof=[];
   for(const side of ['before','after']){
     const result=invoke(stage,['app-guide',stage[side],stage.caseFile,'--json']);
     const review=parseOutput(result);
     assert.equal(review.status,'explicit_approval_required');
     assert.equal(review.readyForApproval,true);
     assert.equal(review.formalCaseSchemaValidated,true);
     assert.deepEqual(review.reviewGaps,[]);
     assert.equal(review.sourceSha256,SHA(stage[side]));
     assert.equal(review.caseSha256,SHA(stage.caseFile));
     assert.equal(review.approvalToken,approvalToken(SHA(stage[side]),SHA(stage.caseFile)));
     assert.deepEqual(review.operationCandidates.map(row=>row.service+'.'+row.operation),
       ['s3.PutObject']);
     assert.equal(review.requiresHumanReview,true);
     assert.equal(review.executedSource,false);
     assert.equal(review.executedAWSCalls,false);
     assert.equal(review.dockerStarted,false);
     assert.equal(review.productionAwsValidated,false);
     proof.push(review);
   }
   assert.notEqual(proof[0].approvalToken,proof[1].approvalToken,
     'Approvals must bind to distinct source bytes and a common case');
   assert.equal(proof[0].caseSha256,proof[1].caseSha256);
 }));

test('read-only draft creation does not import a hostile top-level source',
 {skip:needsPython},()=>stageOwnedCopies(stage=>{
   const marker=path.join(stage.workspace,'SOURCE_EXECUTED_BAD');
   const trap=path.join(stage.workspace,'trap source.py');
   const draft=path.join(stage.workspace,'unexecutable-draft.json');
   const proof=path.join(stage.workspace,'unexecutable-proof.json');
   writeFileSync(trap,`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("MUST_NOT_EXECUTE")\ndef handle(clients, inputs):\n    clients["s3"].put_object(Bucket=inputs["bucket"], Key=inputs["key"], Body=inputs["receipt"].encode("utf-8"))\n`);
   const scan=parseOutput(invoke(stage,['app-case-inspect',trap,'--json']));
   assert.equal(scan.executedSource,false);
   assert.equal(existsSync(marker),false);
   const created=parseOutput(invoke(stage,['app-guide',trap,'--draft',draft,'--json']));
   assert.equal(created.draftWritten,true);
   assert.equal(created.executedSource,false);
   assert.equal(created.dockerStarted,false);
   const sketch=JSON.parse(readFileSync(draft,'utf8'));
   assert.equal(sketch.reviewRequired,true);
   assert.deepEqual(sketch.setup,[]);
   assert.deepEqual(sketch.checks,[]);
   assert.deepEqual(sketch.cleanup,[]);
   assert.equal(existsSync(marker),false);
   const pair=parseOutput(invoke(stage,['app-guide',trap,'--draft-proof',proof,'--json']));
   assert.equal(pair.proofDraftWritten,true);
   assert.equal(pair.expectedRedDraftWritten,true);
   assert.equal(pair.readyForApproval,false);
   assert.equal(pair.approvalToken,null);
   assert.equal(pair.executedSource,false);
   assert.equal(pair.dockerStarted,false);
   for(const file of [proof,proof.replace(/\.json$/,'.expected-red.json')]){
     assert.equal(existsSync(file),true);
     assert.equal(JSON.parse(readFileSync(file,'utf8')).reviewRequired,true);
   }
   assert.equal(existsSync(marker),false,
     'No chosen source, including an unsafe top-level expression, may run during review');
 }));

test('absolute-path app-case-compare reaches local-Docker safety gate without executing code',
 ()=>stageOwnedCopies(stage=>{
   const bin=path.join(stage.workspace,'synthetic docker command folder');
   mkdirSync(bin);
   const touched=path.join(stage.workspace,'UNEXPECTED_DOCKER_INVOKED');
   // This executable would write a marker if the CLI ever tried to start Docker.
   // DOCKER_HOST is deliberately nonlocal: the CLI must refuse before spawn.
   const docker=path.join(bin,process.platform==='win32'?'docker.cmd':'docker');
   const script=process.platform==='win32'
     ? '@echo off\necho UNEXPECTED>"%PILOT_DOCKER_MARKER%"\nexit /b 99\n'
     : '#!/bin/sh\nprintf "UNEXPECTED" > "$PILOT_DOCKER_MARKER"\nexit 99\n';
   writeFileSync(docker,script);
   if(process.platform!=='win32')chmodSync(docker,0o755);
   const env={PATH:bin+path.delimiter+process.env.PATH,
     PILOT_DOCKER_MARKER:touched};
   const valid=invoke(stage,['app-case-compare',stage.before,stage.after,
     stage.caseFile,'--json'],env);
   assert.equal(valid.status,1,valid.stderr);
   assert.equal(valid.stdout,'',
     'No before/after emulator results may be fabricated without real execution');
   assert.match(valid.stderr,/Refusing nonlocal DOCKER_HOST/);
   assert.doesNotMatch(valid.stderr,/SYNTHETIC_PILOT_ONLY_DO_NOT_ECHO|SYNTHETIC_PILOT_SECRET_DO_NOT_ECHO/);
   assert.equal(existsSync(touched),false,'Docker must not be invoked');
   // The same absolute file in both positions must fail the SHA-256 revision
   // gate even earlier; neither invalid request can run user source.
   const same=invoke(stage,['app-case-compare',stage.before,stage.before,
     stage.caseFile,'--json'],env);
   assert.equal(same.status,2,same.stderr);
   assert.equal(same.stdout,'');
   assert.match(same.stderr,/distinct source revisions/);
   assert.equal(existsSync(touched),false);
 }));

test('README distinguishes static review, explicit execution and recorded evidence',()=>{
 const guide=readFileSync(path.join(FIXTURE,'README.md'),'utf8');
 assert.match(guide,/mktemp -d '\.\.\/external receipt pilot\.XXXXXX'/);
 assert.match(guide,/outside the checkout/i);
 assert.match(guide,/app-case-inspect/);
 assert.match(guide,/app-guide/);
 assert.match(guide,/app-case-compare/);
 assert.match(guide,/--draft/);
 assert.match(guide,/reviewRequired: true/);
 assert.match(guide,/--prebuilt-only/);
 assert.match(guide,/imageReusable: true/);
 assert.match(guide,/no approval-token option/);
 assert.match(guide,/Any executed result must be recorded separately/);
 assert.match(guide,/independent-user adoption or AWS production parity/);
 assert.match(guide,/not evidence from an independent customer/i);
});
