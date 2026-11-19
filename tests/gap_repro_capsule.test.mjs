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
