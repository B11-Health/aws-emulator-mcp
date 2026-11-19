/**
 * Offline Capability Confidence / Gap Radar. It reads only project-maintained,
 * hash-pinned historical evidence and the checked-in fixed probe allowlist.
 * NEVER starts Docker, imports application source, calls AWS or reads credentials.
 * No per-operation current Botocore model inventory is bundled.
 */
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {compareAppCaseEvidence} from './app_case_compare.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const OPERATION=/^([a-z][a-z0-9-]{0,63})\.([A-Z][A-Za-z0-9]{0,80})$/;
// Pinned, project-maintained snapshot contents in the PR #85 base. These are
// NOT upstream signatures, attestations or independent external verification.
const EVIDENCE=Object.freeze({
  manifest:{path:'src/aws_emulator_mcp/aws_sdk.py',sha256:'97fedd127b95d15e5c32fb98dc63715c8f280a292c356e0e9c822b2b0039ae46'},
  coverage:{path:'docs/evidence/coverage-aws-emulator-1.0.343.json',sha256:'e6eda5bb8f2b059583ec67e842095ae7cba77786855cc8b219608e8d20243c57'},
  app:{path:'docs/evidence/app-case-aws-emulator-1.0.506.json',sha256:'bad52642581a81ba1c6e0c3e6cf858f0c433f2c618540870f4dfd0c05e6ff6c5'},
});
const APP_INPUTS=Object.freeze({
  case:'examples/app-case/sqs-idempotency.json',
  before:'examples/app-case/buggy.py',
  after:'examples/app-case/fixed.py',
});
const digest=raw=>createHash('sha256').update(raw).digest('hex');
const error=()=>Error('Offline capability evidence is missing, changed or inconsistent; no operation success is credited');

function readBundled(root,read,relative,expectedSha=null) {
  // Fixed project paths only. No user-selected URLs or arbitrary file reads.
  let raw;
  try {
    const filename=path.join(root,relative);
    const stat=lstatSync(filename);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size<1 || stat.size>512*1024)
      throw error();
    raw=read(filename);
  } catch { throw error(); }
  if(!Buffer.isBuffer(raw) || raw.length<1 || raw.length>512*1024 ||
      (expectedSha && digest(raw)!==expectedSha)) throw error();
  return raw;
}
function decode(raw) {
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)); }
  catch { throw error(); }
}
function source(relative,raw,version=null) {
  return {path:relative,sha256:digest(raw),...(version?{emulatorVersion:version}:{})};
}
function allowlistedProbes(raw) {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);
  const m=text.match(/^READ_ONLY_PROBES = \(\r?\n([\s\S]*?)^\)/m);
  if(!m) throw error();
  const rows=m[1].trimEnd().split(/\r?\n/);
  if(rows.length!==20) throw error();
  const names=rows.map(row=>{
    const match=row.match(/^\s{4}\("([a-z][a-z0-9-]{0,63})", "([A-Z][A-Za-z0-9]{0,80})"\),$/);
    if(!match) throw error();
    return match[1]+'.'+match[2];
  });
  if(new Set(names).size!==names.length) throw error();
  return new Set(names);
}
function coverageRecord(data,allowed) {
  if(!data || data.schemaVersion!==1 || data.emulatorVersion!=='Version: 1.0.343' ||
      data.modeledServiceCount!==436 || data.totalProbes!==20 ||
      data.probedServiceCount!==20 || data.successfulProbes!==20 ||
      !Array.isArray(data.results) || data.results.length!==20) throw error();
  const found=new Map();
  for(const row of data.results) {
    const key=row?.service+'.'+row?.operation;
    if(!allowed.has(key) || found.has(key) || row.status!=='responded' ||
       typeof row.durationMs!=='number' || !Number.isFinite(row.durationMs) || row.durationMs<0)
      throw error();
    found.set(key,row);
  }
  if(found.size!==allowed.size) throw error();
  return found;
}
function verifiedApp(data,spec,beforeRaw,afterRaw) {
  if(data?.schemaVersion!==1 || data.recordedDate!=='2026-11-18' ||
      !data.before || !data.after || !data.comparison ||
      data.comparison.productionAwsValidated!==false) throw error();
  let comparison;
  try {
    comparison=compareAppCaseEvidence(data.before,digest(beforeRaw),1,
      data.after,digest(afterRaw),0,spec);
  } catch { throw error(); }
  if(!comparison.passed || comparison.emulatorVersion!=='Version: 1.0.506' ||
      !isDeepStrictEqual(comparison,data.comparison)) throw error();
  return comparison;
}

export function capabilityTruth(selected,{root=ROOT,read=readFileSync}={}) {
  const match=typeof selected==='string' ? selected.match(OPERATION) : null;
  if(!match) throw Error('Choose one exact SDK identifier: SERVICE.OPERATION (example: sqs.SendMessage)');
  const key=match[0];
  const sdkRaw=readBundled(root,read,EVIDENCE.manifest.path,EVIDENCE.manifest.sha256);
  const coverageRaw=readBundled(root,read,EVIDENCE.coverage.path,EVIDENCE.coverage.sha256);
  const appRaw=readBundled(root,read,EVIDENCE.app.path,EVIDENCE.app.sha256);
  const caseRaw=readBundled(root,read,APP_INPUTS.case);
  const beforeRaw=readBundled(root,read,APP_INPUTS.before);
  const afterRaw=readBundled(root,read,APP_INPUTS.after);
  const selectedProbes=coverageRecord(decode(coverageRaw),allowlistedProbes(sdkRaw));
  const spec=decode(caseRaw);
  const comparison=verifiedApp(decode(appRaw),spec,beforeRaw,afterRaw);
  const relevantWrites=spec.invoke.expectedCalls.filter(x=>x.service+'.'+x.operation===key);
  const relevantChecks=spec.checks.filter(x=>x.service+'.'+x.operation===key);
  const afterSuccessfulSdkCall=relevantWrites.length>0 && relevantWrites.every(x=>
     comparison.after.sdkCalls.some(a=>a.service===x.service && a.operation===x.operation && a.successes>0));
  const afterIndependentCheck=relevantChecks.length>0 && relevantChecks.every(x=>
     comparison.after.checks.some(c=>c.id===x.id && c.passed && c.assertions.length>0));
  const appRole=afterSuccessfulSdkCall ? 'application_sdk_write' :
    afterIndependentCheck ? 'independent_postcondition_read' : null;
  const historicalProbe=selectedProbes.get(key);
  const sources=[source(EVIDENCE.manifest.path,sdkRaw),
    source(EVIDENCE.coverage.path,coverageRaw,'Version: 1.0.343')];
  if(appRole) {
    sources.push(source(EVIDENCE.app.path,appRaw,'Version: 1.0.506'),
      source(APP_INPUTS.case,caseRaw),source(APP_INPUTS.before,beforeRaw),
      source(APP_INPUTS.after,afterRaw));
  }
  const appProof=appRole ? {
    status:'verified_recorded_app_case',
    role:appRole,
    emulatorVersion:comparison.emulatorVersion,
    caseName:comparison.case,
    caseSha256:comparison.caseSha256,
    beforeSourceSha256:comparison.before.sourceSha256,
    afterSourceSha256:comparison.after.sourceSha256,
    namedRegression:comparison.regression.stepId+'.'+comparison.regression.path,
    bugReproduced:comparison.bugReproduced,
    fixVerified:comparison.fixVerified,
    cleanupPassedBoth:comparison.before.cleanupPassed&&comparison.after.cleanupPassed,
    ...(appRole==='application_sdk_write' ? {
      afterSuccessfulCalls:comparison.after.sdkCalls.find(x=>x.service+'.'+x.operation===key).successes
    } : {
      assertionIds:relevantChecks.map(x=>x.id)
    }),
    evidencePath:EVIDENCE.app.path,
    caveat:'One project-maintained, hash-checked historical local application case; not independent attestation, full API or real AWS fidelity.'
  } : {status:'UNKNOWN',reason:'No raw, independently rechecked application case for this specific operation in the bundled truth index.'};
  const gaps=['CURRENT_SDK_OPERATION_MODEL_UNCHECKED','AWS_PRODUCTION_FIDELITY_UNKNOWN',
    'FULL_EMULATOR_OPERATION_BEHAVIOR_UNKNOWN'];
  if(!historicalProbe) gaps.push('NO_RECORDED_FIXED_READ_ONLY_PROBE');
  if(!appRole) gaps.push('NO_REVERIFIED_APP_POSTCONDITION');
  return {
    schemaVersion:1,mode:'offline_capability_truth',query:key,
    sdkModel:{status:'UNKNOWN',
      historicalStatus:historicalProbe||appRole ? 'modeled_at_recorded_test_time' : 'UNKNOWN',
      historicalSdkUseObserved:Boolean(historicalProbe||appRole),
      reason:'Current per-operation Botocore models are unverified. A successful historical SDK operation implies model availability only at that recorded run; the 436-service aggregate is NOT emulator implementation.'},
    signedEmulatorProbe:historicalProbe ? {
      status:'recorded_responded',emulatorVersion:'Version: 1.0.343',
      operation:key,requestScope:'fixed zero-argument read-only SDK smoke test',
      evidencePath:EVIDENCE.coverage.path,
      caveat:'Historical project-maintained signed-local-emulator report; not a live rerun, upstream attestation, or complete implementation proof.'
    } : {status:'UNKNOWN',reason:'Not in the checked-in 20-operation zero-argument read-only probe record.'},
    appProof,unknowns:gaps,sources,
    limitations:'Offline historical evidence only; no Docker, AWS calls or model inspection performed. No claim of current service support, IAM correctness, SDK catalog coverage, production AWS parity or independent audit.'
  };
}

export function formatCapabilityTruth(result) {
  const lines=[`Capability Confidence / Gap Radar — ${result.query}`,
    `  Current SDK operation model: ${result.sdkModel.status}`,
    `  Historic signed-local read-only probe: ${result.signedEmulatorProbe.status}`,
    `  App-level state proof: ${result.appProof.status}`];
  if(result.signedEmulatorProbe.emulatorVersion) lines.push(`    Observed on ${result.signedEmulatorProbe.emulatorVersion}; zero-argument response only`);
  if(result.appProof.emulatorVersion) lines.push(`    ${result.appProof.role} on ${result.appProof.emulatorVersion}, ${result.appProof.namedRegression}`);
  lines.push(`  Remains UNKNOWN: ${result.unknowns.join(', ')}`,
    '  Evidence (repo-relative path, SHA-256, recorded emulator version):');
  for(const x of result.sources) lines.push(`    ${x.path} sha256:${x.sha256}${x.emulatorVersion?' ['+x.emulatorVersion+']':''}`);
  lines.push(`  ${result.limitations}`);
  return lines.join('\n')+'\n';
}
