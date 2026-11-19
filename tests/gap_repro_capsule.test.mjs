import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGapReproCapsule} from '../scripts/gap_repro_capsule.mjs';
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const sqs=load('docs/evidence/app-case-aws-emulator-1.0.506.json');
test('raw failed application becomes a redacted capsule',()=>{
 const c=createGapReproCapsule(sqs.before);
 assert.equal(c.kind,'emulator_gap_reproduction_capsule');
 assert.equal(c.target.handlerOperation,'sqs.SendMessage');
 assert.equal(c.target.independentReadOperation,'sqs.ReceiveMessage');
 assert.equal(c.target.failedAssertions[0].pathShape,'Messages.1');
 assert.equal(c.emulator.version,'1.0.506');
 assert.equal(c.interpretation.emulatorIncompatibilityEstablished,false);
});
const s3=load('docs/evidence/app-case-s3-aws-emulator-1.0.506.json');
const guided=load('docs/evidence/guided-app-case-aws-emulator-1.0.511.json');
test('comparison reports identify application regressions, not emulator faults',()=>{
 for(const [r,op,assertion] of [[sqs.comparison,'sqs.SendMessage','Messages.1'],
   [s3.comparison,'s3.PutObject','ContentLength']]){
   const c=createGapReproCapsule(structuredClone(r));
   assert.equal(c.inputFormat,'app_case_comparison');
   assert.equal(c.interpretation.classification,'application_regression_demonstrated');
   assert.equal(c.interpretation.emulatorIncompatibilityEstablished,false);
   assert.equal(c.target.handlerOperation,op);
   assert.equal(c.target.failedAssertions[0].pathShape,assertion);
   assert.equal(c.identities.otherSourceSha256,r.after.sourceSha256);
   assert.equal(c.identities.side,'before');
   assert.match(c.reproduction.runCommandTemplate,/app-case-compare "TRUSTED_BEFORE.py"/);
   assert.equal(c.emulator.version,'1.0.506');
 }
});
test('developer-approved guided local run also becomes a capsule',()=>{
 const r=guided.negativeControl;
 const c=createGapReproCapsule(structuredClone(r));
 assert.equal(c.inputFormat,'approved_app_guide_result');
 assert.equal(c.identities.sourceSha256,r.sourceSha256);
 assert.equal(c.identities.caseSha256,r.caseSha256);
 assert.equal(c.emulator.version,'1.0.511');
 assert.equal(c.target.handlerOperation,'s3.PutObject');
 assert.equal(c.target.failedAssertions[0].pathShape,'ContentLength');
 assert.equal(c.interpretation.emulatorIncompatibilityEstablished,false);
});
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readGapReport,parseGapReproArgs} from '../scripts/gap_repro_capsule.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bin=path.join(root,'bin/aws-emulator-mcp.mjs');
const run=file=>spawnSync(process.execPath,[bin,'gap-capsule',file],{
 encoding:'utf8',timeout:15000,env:{PATH:'/nonexistent',HOME:'/tmp'}});
function withFile(content,fn){
 const folder=mkdtempSync(path.join(tmpdir(),'gap-repro-inert-'));
 try{const file=path.join(folder,'report.json');writeFileSync(file,content);
   return fn(file,folder);
 }finally{rmSync(folder,{recursive:true,force:true});}
}
test('CLI reads only saved JSON and never invokes Python or Docker',()=>{
 withFile(JSON.stringify(sqs.before),(file,folder)=>{
   const result=run(file);
   assert.equal(result.status,0,result.stderr);
   assert.equal(result.stderr,'');
   const c=JSON.parse(result.stdout);
   assert.equal(c.kind,'emulator_gap_reproduction_capsule');
   assert.equal(c.target.handlerOperation,'sqs.SendMessage');
   assert.equal(existsSync(path.join(folder,'unrequested-output.json')),false);
 });
});
test('strict output redaction removes all untrusted values and identifiers',()=>{
 const r=structuredClone(sqs.before);
 const secret='PRIVATE_APPLICATION_TOKEN_NEVER_ECHO';
 r.case=secret;
 r.localSourcePath='C:/Users/private-name/handler.py';
 r.extra={credentials:secret,rawPayload:secret,endpoint:secret};
 r.checks[1].errorCode=secret;
 r.checks[1].assertions[1].path=secret;
 const c=createGapReproCapsule(r);
 const output=JSON.stringify(c);
 assert.doesNotMatch(output,/PRIVATE_APPLICATION_TOKEN|private-name|C:\/Users/);
 assert.equal(c.target.failedAssertions[0].pathShape,'<redacted-assertion-path>');
 assert.equal(Object.hasOwn(c.target.failedAssertions[0],'pathSha256'),false);
 assert.equal(c.redaction.credentialsIncluded,false);
 assert.equal(c.redaction.pathsIncluded,false);
});
test('forged success, mismatched counts and unverified source identity fail closed',()=>{
 for(const mutate of [
   x=>{x.sourceSha256='not-a-digest'},
   x=>{x.caseSha256='z'.repeat(64)},
   x=>{x.passed=true},
   x=>{x.cleanupPassed=false},
   x=>{x.cleanup[0].passed=false},
   x=>{x.expectedCalls[0].observed=99},
   x=>{x.sdkCalls[0].successes=999},
   x=>{x.accountVerified=false},
   x=>{x.productionAwsValidated=true},
   x=>{x.emulatorVersion='Version: unexpected payload'},
   x=>{x.checks[1].assertions[1].passed=true},
 ]){
   const r=structuredClone(sqs.before);mutate(r);
   assert.throws(()=>createGapReproCapsule(r),/Unsupported or inconsistent/);
 }
});
test('false comparison fixed/cleanup/version claims cannot become trusted capsules',()=>{
 for(const mutate of [
   x=>{x.before.sourceSha256=x.after.sourceSha256},
   x=>{x.regression.stepId='wrong'},
   x=>{x.regression.path='different'},
   x=>{x.after.checks[1].assertions[1].passed=false},
   x=>{x.after.cleanupPassed=false},
   x=>{x.before.emulatorVersion='Version: 1.0.999'},
   x=>{x.fixVerified=false},
 ]){
   const r=structuredClone(sqs.comparison);mutate(r);
   assert.throws(()=>createGapReproCapsule(r),/Unsupported or inconsistent/);
 }
});
test('successful runs and malformed JSON never produce issue capsules',()=>{
 assert.throws(()=>createGapReproCapsule(structuredClone(sqs.after)));
 for(const text of ['{','[]','null','{"schemaVersion":1}','UNSAFE_INPUT']){
   withFile(text,file=>{
     const reply=run(file);
     assert.equal(reply.status,2);
     assert.equal(reply.stdout,'');
     assert.match(reply.stderr,/Invalid or unsupported local app-case report/);
     assert.doesNotMatch(reply.stderr,/UNSAFE_INPUT/);
   });
 }
});
test('report size and symlink restrictions block file access',()=>{
 withFile('x'.repeat(256*1024+1),(file,folder)=>{
   assert.equal(run(file).status,2);
   const valid=path.join(folder,'valid.json');writeFileSync(valid,JSON.stringify(sqs.before));
   const alias=path.join(folder,'alias.json');symlinkSync(valid,alias);
   assert.equal(run(alias).status,2);
 });
});
test('URLs, UNC and device paths are refused; local POSIX/drive paths remain legal',()=>{
 const bad=[
   'https://example.invalid/case.json','file:///tmp/private.json',
   String.raw`\\server.invalid\share\report.json`,
   '//server.invalid/share/report.json',
   String.raw`\\?\C:\files\report.json`,
   String.raw`\Device\LanmanRedirector\report.json`,
   String.raw`/\server.invalid/share/report.json`,
   'not-json.txt','--input',
 ];
 for(const p of bad){
   assert.throws(()=>parseGapReproArgs([p]));
   assert.throws(()=>readGapReport(p));
 }
 for(const p of ['./saved.json','/tmp/saved.json',String.raw`C:\Users\Developer\saved.json`])
   assert.equal(parseGapReproArgs([p]),p);
});
test('identity evidence is format-scoped: guided report never implies account verification',()=>{
 const raw=createGapReproCapsule(sqs.before);
 const compared=createGapReproCapsule(sqs.comparison);
 const approved=createGapReproCapsule(guided.negativeControl);
 assert.equal(raw.emulator.accountVerifiedInReport,true);
 assert.equal(compared.emulator.accountVerifiedInReport,true);
 assert.equal(approved.emulator.accountVerifiedInReport,'not_reported');
 assert.equal(approved.emulator.versionIndependentlyAttested,false);
 assert.equal(approved.interpretation.emulatorIncompatibilityEstablished,false);
 assert.equal(approved.interpretation.productionAWSParityEstablished,false);
 assert.doesNotMatch(JSON.stringify(approved),/emulator gap confirmed|aws parity established/i);
});
test('forged identity flags cannot upgrade guided evidence to verified account',()=>{
 for(const mutate of [
   x=>{x.accountVerified=true;},
   x=>{x.accountVerified=false;},
   x=>{x.proof.accountVerified=true;},
   x=>{x.proof.accountVerified=false;},
 ]){
   const report=structuredClone(guided.negativeControl);mutate(report);
   assert.throws(()=>createGapReproCapsule(report),/Unsupported or inconsistent/);
 }
 for(const mutate of [x=>{delete x.accountVerified},x=>{x.accountVerified='not_reported'}]){
   const report=structuredClone(sqs.before);mutate(report);
   assert.throws(()=>createGapReproCapsule(report),/Unsupported or inconsistent/);
 }
 for(const mutate of [x=>{delete x.accountVerified},x=>{x.accountVerified='verified'}]){
   const report=structuredClone(sqs.comparison);mutate(report);
   assert.throws(()=>createGapReproCapsule(report),/Unsupported or inconsistent/);
 }
});

test('comparison rejects forged green regression with contradictory expected SDK attempts',()=>{
 const r=structuredClone(sqs.comparison);
 for(const side of [r.before,r.after])for(const op of side.sdkCalls){op.attempts=0;op.successes=0;}
 // The summarized runner still claims two observed attempts. Never trust that
 // classification over the SDK call counters.
 assert.throws(()=>createGapReproCapsule(r),/Unsupported or inconsistent/);
});

test('comparison requires successful expected SDK operations AFTER fix, not just attempts',()=>{
 const r=structuredClone(sqs.comparison);
 for(const op of r.after.sdkCalls)op.successes=0;
 assert.throws(()=>createGapReproCapsule(r),/Unsupported or inconsistent/);
 const passed=structuredClone(sqs.comparison);
 passed.before.expectedCalls[0].observed=0;
 assert.throws(()=>createGapReproCapsule(passed),/Unsupported or inconsistent/);
 const missing=structuredClone(sqs.comparison);
 delete missing.after.expectedCalls;
 assert.throws(()=>createGapReproCapsule(missing),/Unsupported or inconsistent/);
});

test('valid injected before-call retries preserve attempt-pass despite zero baseline successes',()=>{
 const historical=load('docs/evidence/app-case-sqs-retry-aws-emulator-1.0.508.json');
 const before=historical.comparison.before;
 assert.equal(before.sdkCalls[0].attempts,1);
 assert.equal(before.sdkCalls[0].successes,0);
 assert.equal(before.expectedCalls[0].passed,true);
 assert.equal(createGapReproCapsule(historical.comparison).interpretation.classification,
   'application_regression_demonstrated');
 const raw=load('docs/evidence/app-case-sqs-retry-aws-emulator-1.0.506.json');
 assert.equal(raw.before.expectedCalls[0].passed,true);
 assert.equal(raw.before.sdkCalls[0].successes,0);
 const capsule=createGapReproCapsule(raw.before);
 assert.equal(capsule.interpretation.emulatorIncompatibilityEstablished,false);
 assert.equal(capsule.target.observedSdkCalls[0].successes,0);
 assert.equal(createGapReproCapsule(s3.comparison).target.handlerOperation,'s3.PutObject');
});

test('guided successfulExpectedOperations cannot override zero SDK successes',()=>{
 for(const flip of [
  r=>{r.proof.sdkCalls[0].successes=0;},
  r=>{r.proof.sdkCalls[0].attempts=0;r.proof.sdkCalls[0].successes=0;},
  r=>{r.successfulExpectedOperations=false;},
  r=>{r.proof.expectedCalls[0].observed=0;},
  r=>{r.proof.expectedCalls[0].min=0;},
 ]){
  const r=structuredClone(guided.negativeControl);flip(r);
  assert.throws(()=>createGapReproCapsule(r),/Unsupported or inconsistent/);
 }
});

test('raw and summary expected-count evidence rejects contradictions, preserves red baseline',()=>{
 for(const flip of [
  r=>{r.expectedCalls[0].min=3;r.expectedCalls[0].max=4;},
  r=>{r.expectedCalls[0].min=3;r.expectedCalls[0].max=2;},
  r=>{r.expectedCalls[0].passed=false;},
  r=>{r.expectedCalls.push(structuredClone(r.expectedCalls[0]));},
  r=>{r.expectedCalls[0].successes=999;},
 ]){
  const r=structuredClone(sqs.before);flip(r);
  assert.throws(()=>createGapReproCapsule(r),/Unsupported or inconsistent/);
 }
});

test('unknown or conflicting assertion service cannot become unrelated handler attribution',()=>{
 const conflicting=structuredClone(guided.negativeControl);
 conflicting.proof.checks[0].assertions[0].path='Messages.0.Body';
 const c=createGapReproCapsule(conflicting);
 assert.equal(c.target.handlerOperation,null);
 assert.equal(c.target.independentReadOperation,null);
 assert.equal(c.target.failedAssertions[0].pathShape,'Messages.0.Body');
 assert.equal(c.interpretation.emulatorIncompatibilityEstablished,false);
 const unknown=structuredClone(guided.negativeControl);
 unknown.proof.checks[0].assertions[0].path='SECRET_PRIVATE_ASSERTION';
 const u=createGapReproCapsule(unknown);
 assert.equal(u.target.handlerOperation,null);
 assert.equal(u.target.failedAssertions[0].pathShape,'<redacted-assertion-path>');
});

test('docs require PowerShell 7+ UTF-8 without BOM and do not claim exact exported bytes',()=>{
 const doc=readFileSync('docs/GAP_REPRO_CAPSULE.md','utf8');
 assert.match(doc,/PowerShell 7\+/);
 assert.match(doc,/Set-Content -LiteralPath .* -Encoding utf8NoBOM/);
 assert.match(doc,/Windows PowerShell 5\.1/);
 assert.match(doc,/UTF-16LE/);
 assert.match(doc,/do \*\*not\*\* claim byte-for-byte identity/);
 assert.match(doc,/min.*max.*passed/s);
 assert.match(doc,/same ordered independent check IDs and assertion paths/);
 assert.match(doc,/injected before-call fault metadata/);
 assert.match(doc,/do \*\*not\*\* independently attest/);
});

test('forged hash identities reject mismatches but never pretend to attest files',()=>{
 for(const flip of [
  r=>{r.sourceSha256='a'.repeat(64);},
  r=>{r.caseSha256='not-a-hash';},
 ]){
  const r=structuredClone(guided.negativeControl);flip(r);
  assert.throws(()=>createGapReproCapsule(r),/Unsupported or inconsistent/);
 }
 const collision=structuredClone(sqs.comparison);
 collision.after.sourceSha256=collision.before.sourceSha256;
 assert.throws(()=>createGapReproCapsule(collision),/Unsupported or inconsistent/);
 const r=structuredClone(sqs.before);
 r.sourceSha256='a'.repeat(64); // No original source is supplied, so shape is all we can check.
 const capsule=createGapReproCapsule(r);
 assert.equal(capsule.reportConfidence,'report_fields_checked_not_independently_attested');
 assert.equal(capsule.identities.sourceSha256,'a'.repeat(64));
 assert.equal(capsule.emulator.versionIndependentlyAttested,false);
});

test('green comparison requires the same named regression check and assertion path after the fix',()=>{
 const original=structuredClone(sqs.comparison);
 const baseline=createGapReproCapsule(original);
 assert.equal(baseline.interpretation.classification,'application_regression_demonstrated');
 assert.equal(baseline.interpretation.emulatorIncompatibilityEstablished,false);
 for(const mutate of [
   r=>{r.after.checks.find(c=>c.id===r.regression.stepId).id='renamed-postcondition';},
   r=>{r.after.checks.find(c=>c.id===r.regression.stepId).assertions[1].path='Messages.7';},
   r=>{r.after.checks=r.after.checks.filter(c=>c.id!==r.regression.stepId);},
   r=>{r.after.checks.find(c=>c.id===r.regression.stepId).assertions.splice(1,1);},
   r=>{r.after.checks.find(c=>c.id===r.regression.stepId).assertions[1].path='Messages.0.Body';},
   r=>{r.after.checks[0].assertions[0].path='Item.other.S';},
   r=>{r.after.checks.push(structuredClone(r.after.checks[0]));},
 ]) {
   const modified=structuredClone(original);mutate(modified);
   assert.throws(()=>createGapReproCapsule(modified),/Unsupported or inconsistent/);
 }
});

test('historical S3 and SQS comparisons retain the same observed named assertion after the fix',()=>{
 for(const input of [sqs.comparison,s3.comparison]) {
   const after=input.after.checks.find(c=>c.id===input.regression.stepId);
   assert.ok(after);
   assert.equal(after.assertions.find(a=>a.path===input.regression.path)?.passed,true);
   const result=createGapReproCapsule(structuredClone(input));
   assert.equal(result.interpretation.classification,'application_regression_demonstrated');
   assert.equal(result.interpretation.emulatorIncompatibilityEstablished,false);
 }
});

test('zero-success baseline cannot be a demonstrated regression without a consistent injected before-call fault',()=>{
 const original=load('docs/evidence/app-case-sqs-retry-aws-emulator-1.0.508.json').comparison;
 assert.equal(original.before.sdkCalls[0].successes,0);
 assert.equal(original.before.appFault.mode,'before-call');
 assert.equal(createGapReproCapsule(original).interpretation.classification,'application_regression_demonstrated');
 for(const mutate of [
   r=>{delete r.before.appFault;},
   r=>{delete r.before.appFault;delete r.after.appFault;},
   r=>{r.before.appFault.injected=false;},
   r=>{r.before.appFault.sentToEmulator=true;},
   r=>{r.before.appFault.mode='after-success';r.before.appFault.sentToEmulator=true;},
   r=>{r.before.appFault.occurrence=2;},
   r=>{r.before.appFault.occurrence=0;},
   r=>{r.before.appFault.service='s3';r.before.appFault.operation='PutObject';},
   r=>{r.before.appFault.operation='ReceiveMessage';},
   r=>{r.before.appFault.injected='true';},
   r=>{r.after.appFault.occurrence=2;},
   r=>{delete r.after.appFault;},
 ]) {
   const modified=structuredClone(original);mutate(modified);
   assert.throws(()=>createGapReproCapsule(modified),/Unsupported or inconsistent/);
 }
});

test('unexplained zero-success before-side write cannot piggyback a normal regression',()=>{
 const modified=structuredClone(sqs.comparison);
 for(const c of modified.before.sdkCalls)c.successes=0;
 assert.throws(()=>createGapReproCapsule(modified),/Unsupported or inconsistent/);
});
