/** Offline issue-triage capsule from EXISTING declarative app-case JSON reports.
 * No app source, Docker, AWS client, credentials, environment values or logs.
 * Never attribute an application failure to AWS Emulator by inference.
 */
import {createHash} from 'node:crypto';
import {openSync,readSync,closeSync,fstatSync,lstatSync,constants as fsConstants} from 'node:fs';

const SHA=/^[a-f0-9]{64}$/;
const VERSION=/^Version: ([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,5}(?:-[a-z0-9.]{1,24})?)$/i;
const MAX_BYTES=256*1024;
const MAX_RECORDS=24;
const OPS=Object.freeze({
  s3:new Set(['CreateBucket','DeleteBucket','PutObject','GetObject','HeadObject','DeleteObject','ListObjectsV2']),
  sqs:new Set(['CreateQueue','DeleteQueue','SendMessage','ReceiveMessage','DeleteMessage','GetQueueAttributes']),
  dynamodb:new Set(['CreateTable','DeleteTable','DescribeTable','PutItem','GetItem','UpdateItem','DeleteItem','Query','Scan']),
});
const malformed=()=>{throw Error('Unsupported or inconsistent app-case report; no capsule produced');};
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);
const bool=v=>typeof v==='boolean';
const bounded=(v,max=128)=>typeof v==='string' && v.length>0 && v.length<=max;
const hash=v=>SHA.test(v||'') ? v : malformed();
const integer=(n,max)=>Number.isInteger(n)&&n>=0&&n<=max;
const safeOperation=(service,operation)=> {
  if(!Object.hasOwn(OPS,service)||!OPS[service].has(operation)) malformed();
  return {service,operation};
};
const version=v=>{
  if(v===null||v===undefined) return null;
  const match=typeof v==='string'&&v.match(VERSION);
  if(!match) malformed();
  return match[1];
};
const safePath=value=>{
  if(!bounded(value,128)) malformed();
  // Do not expose arbitrary field names: custom DynamoDB attributes, event
  // identifiers, tokens and user-controlled paths remain in the reviewed case.
  if(['ContentLength','ETag','QueueUrl','TableName','Count','Item','Messages'].includes(value))
    return value;
  if(/^Messages\.[0-9]{1,2}(?:\.(?:Body|MessageId))?$/.test(value)) return value;
  const ddb=value.match(/^Item\.([A-Za-z][A-Za-z0-9_]{0,63})\.(S|N|BOOL)$/);
  if(ddb) return `Item.${['id','state','status','orderId'].includes(ddb[1])?ddb[1]:'<attribute>'}.${ddb[2]}`;
  return '<redacted-assertion-path>';
};
const safeAssertion=(a,checkIndex,assertionIndex)=>{
  if(!object(a)||!bool(a.passed)) malformed();
  return {checkIndex,assertionIndex,pathShape:safePath(a.path),
    pathSha256:createHash('sha256').update(a.path).digest('hex'),
    expected:'reviewed assertion passes',observed:a.passed?'pass':'fail'};
};
function observedStages(rows,kind,{raw}={raw:false}){
  if(!Array.isArray(rows)||rows.length<1||rows.length>8) malformed();
  return rows.map((row,i)=>{
    const observations=raw||kind==='checks' ? row?.assertions : (row?.assertions??[]);
    if(!object(row)||!bounded(row.id,80)||!bool(row.passed)||
       !Array.isArray(observations)||observations.length>8) malformed();
    const assertions=observations.map((a,j)=>safeAssertion(a,i,j));
    if(raw){
      safeOperation(row.service,row.operation);
      if(!['success','api_error','local_error'].includes(row.observed)) malformed();
      if(row.observed==='success'){
        hash(row.responseSha256);
        if(row.passed!==assertions.every(a=>a.observed==='pass')) malformed();
      }else if(row.passed||assertions.length) malformed();
    }else if(row.passed!==assertions.every(a=>a.observed==='pass')) malformed();
    return {index:i,passed:row.passed,assertions,
      ...(raw?{service:row.service,operation:row.operation,observed:row.observed}:{})};
  });
}
function calls(rows){
  if(!Array.isArray(rows)||rows.length>MAX_RECORDS) malformed();
  const seen=new Set();
  return rows.map(c=>{
    if(!object(c)||!integer(c.attempts,1000)||!integer(c.successes,1000)||
        c.successes>c.attempts) malformed();
    const op=safeOperation(c.service,c.operation);
    const key=op.service+'.'+op.operation;
    if(seen.has(key)) malformed();seen.add(key);
    return {...op,attempts:c.attempts,successes:c.successes};
  });
}
/**
 * The raw runner reports min/max; app-case-compare and app-guide deliberately
 * strip those ranges. Match counters exactly in all formats, but never invent
 * a missing range in a summary. Count pass is distinct from SDK success:
 * synthetic before-call faults can count an attempt without a successful API.
 */
function expectedCallsAgainstSdk(rows,sdkCalls,{raw=false}={}){
  if(!Array.isArray(rows)||rows.length<1||rows.length>8) malformed();
  const shape=raw?'max,min,observed,operation,passed,service':
    'observed,operation,passed,service';
  const seen=new Set();
  let countPassed=true,successful=true;
  for(const row of rows){
    if(!object(row)||Object.keys(row).sort().join(',')!==shape||
       !integer(row.observed,1000)||!bool(row.passed))malformed();
    safeOperation(row.service,row.operation);
    const key=row.service+'.'+row.operation;
    if(seen.has(key))malformed();seen.add(key);
    const call=sdkCalls.find(c=>c.service===row.service&&c.operation===row.operation);
    const attempts=call?.attempts??0;
    if(row.observed!==attempts)malformed();
    if(raw){
      if(!integer(row.min,12)||!integer(row.max,12)||row.min>row.max||
         row.passed!==(row.min<=attempts&&attempts<=row.max))malformed();
    }else if(row.passed&&attempts===0){
      // A summarized 'pass' has no retained min/max to corroborate an
      // observed zero; do not credit an unobserved operation as proven.
      malformed();
    }
    countPassed&&=row.passed;
    successful&&=(call?.successes??0)>0;
  }
  return {countPassed,successful};
}

const flatFailed=checks=>checks.flatMap(c=>c.assertions.filter(a=>a.observed==='fail'));
const firstFault=(checks,stage)=>{
  const record=checks.find(c=>!c.passed);
  if(!record) return null;
  return {stage,stageIndex:record.index,
    ...(record.service?{service:record.service,operation:record.operation}:{}),
    ...(record.observed?{observed:record.observed}:{})};
};
function classify({setup,checks,cleanup,applicationErrors=false,expectedCallsPass=true,
                   comparisonFixed=false}){
  if(setup.some(x=>!x.passed))return 'setup_or_environment_failure';
  if(applicationErrors)return 'application_exception_observed';
  // Absent successful required writes, a standalone failed read does not
  // prove the handler's expected state was ever written. Deliberate faulted
  // before-runs remain legitimate when the full comparison has been checked.
  if(!expectedCallsPass&&!comparisonFixed)return 'required_sdk_write_not_observed';
  if(checks.some(x=>x.assertions.some(a=>a.observed==='fail')))
    return comparisonFixed?'application_regression_demonstrated':'independent_state_assertion_failed';
  if(checks.some(x=>!x.passed))return 'independent_sdk_read_failed';
  if(cleanup.some(x=>!x.passed))return 'cleanup_failure';
  return 'unclassified_local_failure';
}
function rawReport(report){
  if(report.schemaVersion!==1||report.sourceExecution!=='trusted_local_opt_in'||
      report.productionAwsValidated!==false||report.accountVerified!==true||
      !bool(report.sourceInvoked)||!bool(report.applicationErrors)||
      !bool(report.applicationInvariantPassed)||!bool(report.cleanupPassed)||
      report.passed!==false||!bounded(report.case,80)) malformed();
  const sourceSha256=hash(report.sourceSha256),caseSha256=hash(report.caseSha256);
  const emulatorVersion=version(report.emulatorVersion);
  const setup=observedStages(report.setup,'setup',{raw:true});
  const checks=observedStages(report.checks,'checks',{raw:true});
  const cleanup=observedStages(report.cleanup,'cleanup',{raw:true});
  const sdkCalls=calls(report.sdkCalls);
  const expected=expectedCallsAgainstSdk(report.expectedCalls,sdkCalls,{raw:true});
  const fault=report.appFault;
  if(fault!==undefined){
    if(!object(fault)||!['before-call','after-success'].includes(fault.mode)||
       !bool(fault.injected)||!bool(fault.sentToEmulator)||
       fault.sentToEmulator!==(fault.injected&&fault.mode==='after-success'))malformed();
    safeOperation(fault.service,fault.operation);
  }
  const cleanupPassed=cleanup.every(c=>c.passed);
  const invariant=report.sourceInvoked&&!report.applicationErrors&&
    setup.every(c=>c.passed)&&checks.every(c=>c.passed)&&
    expected.countPassed&&expected.successful&&
    (fault===undefined||fault.injected);
  if(report.cleanupPassed!==cleanupPassed||report.applicationInvariantPassed!==invariant||
     report.passed!==(invariant&&cleanupPassed)) malformed();
  return {format:'app_case_result',sourceSha256,caseSha256,emulatorVersion,
    accountVerifiedInReport:true, setup,checks,cleanup,sdkCalls,sourceInvoked:report.sourceInvoked,
    applicationErrors:report.applicationErrors,cleanupPassed,
    expectedCallsPass:expected.countPassed&&expected.successful,
    faultMode:fault?.mode||null};
}
function compareReport(report){
  if(report.schemaVersion!==1||report.mode!=='local_application_before_after'||
     report.productionAwsValidated!==false||report.applicationBehaviorTested!==true||
     report.accountVerified!==true||!bool(report.passed)||
     !bool(report.bugReproduced)||!bool(report.fixVerified)||
     !object(report.regression)||!bounded(report.regression.stepId,80))malformed();
  const caseSha256=hash(report.caseSha256);
  const emulatorVersion=version(report.emulatorVersion);
  const cleanSide=side=>{
    if(!object(side)||!bool(side.passed)||!bool(side.cleanupPassed)||
       !bool(side.invoked)||!bool(side.applicationErrors))malformed();
    hash(side.sourceSha256);
    if(version(side.emulatorVersion)!==emulatorVersion)malformed();
    const setup=observedStages(side.setup,'setup');
    const checks=observedStages(side.checks,'checks');
    const cleanup=observedStages(side.cleanup,'cleanup');
    const sdkCalls=calls(side.sdkCalls);
    const expected=expectedCallsAgainstSdk(side.expectedCalls,sdkCalls);
    if((!side.invoked&&sdkCalls.length)||
       side.cleanupPassed!==cleanup.every(c=>c.passed)||
       side.passed&&(side.applicationErrors||!side.invoked||!side.cleanupPassed||
        !setup.every(x=>x.passed)||!checks.every(x=>x.passed)||
        !expected.countPassed||!expected.successful))malformed();
    return {sourceSha256:side.sourceSha256,setup,checks,cleanup,sdkCalls,
      cleanupPassed:side.cleanupPassed,invoked:side.invoked,applicationErrors:side.applicationErrors,
      expectedCallsPassed:expected.countPassed,expectedCallsSucceeded:expected.successful,
      passed:side.passed};
  };
  const before=cleanSide(report.before),after=cleanSide(report.after);
  if(before.sourceSha256===after.sourceSha256)malformed();
  const beforeFailed=flatFailed(before.checks);
  const match=before.checks.some((c,index)=>report.before.checks[index].id===report.regression.stepId&&
    c.assertions.some(a=>a.pathSha256===createHash('sha256').update(report.regression.path||'').digest('hex')&&a.observed==='fail'));
  const fixed=report.passed&&report.bugReproduced&&report.fixVerified;
  // Original app-case comparison semantics: the before-side attempt range
  // passes (even when an injected before-call fault yields zero successes),
  // but an after-side green verdict requires actual successful SDK writes.
  if(report.bugReproduced&&(!before.invoked||before.applicationErrors||
      !before.expectedCallsPassed||!before.cleanupPassed||before.passed||
      !before.setup.every(x=>x.passed)))malformed();
  if(report.fixVerified&&(!after.passed||!after.expectedCallsPassed||
      !after.expectedCallsSucceeded))malformed();
  if(fixed&&(!match||beforeFailed.length!==1||before.passed||!after.passed||
     !before.cleanupPassed||!after.cleanupPassed||
     flatFailed(after.checks).length))malformed();
  if(report.passed!==fixed)malformed();
  const failing=before.passed?after:before;
  if(failing.passed)malformed();
  return {format:'app_case_comparison',sourceSha256:failing.sourceSha256,
    relatedSourceSha256:(failing===before?after:before).sourceSha256,
    caseSha256,emulatorVersion,accountVerifiedInReport:true,
    setup:failing.setup,checks:failing.checks,cleanup:failing.cleanup,
    sdkCalls:failing.sdkCalls,sourceInvoked:failing.invoked,
    applicationErrors:failing.applicationErrors,cleanupPassed:failing.cleanupPassed,
    expectedCallsPass:failing.expectedCallsPassed&&failing.expectedCallsSucceeded,
    comparisonFixed:fixed,
    compareSide:failing===before?'before':'after',faultMode:null};
}

function guidedReport(report){
  const proof=report.proof;
  if(report.schemaVersion!==1||report.mode!=='approved_trusted_app_case'||
      report.passed!==false||report.productionAwsValidated!==false||
      report.applicationBehaviorTested!==true||report.localExecutionApproved!==true||
      report.sourceExecution!=='trusted_local_opt_in'||
      !bool(report.successfulExpectedOperations)||!object(proof)||
      !bool(proof.passed)||!bool(proof.invoked)||!bool(proof.applicationErrors)||
      !bool(proof.cleanupPassed)||
      // Guided evidence does not report an account-identity attestation. An
      // injected field cannot upgrade a missing check into a verified one.
      Object.hasOwn(report,'accountVerified')||Object.hasOwn(proof,'accountVerified'))malformed();
  const sourceSha256=hash(report.sourceSha256),caseSha256=hash(report.caseSha256);
  if(proof.sourceSha256!==sourceSha256||
      report.passed!==(proof.passed&&report.successfulExpectedOperations))malformed();
  const setup=observedStages(proof.setup,'setup');
  const checks=observedStages(proof.checks,'checks');
  const cleanup=observedStages(proof.cleanup,'cleanup');
  const sdkCalls=calls(proof.sdkCalls);
  if(proof.cleanupPassed!==cleanup.every(x=>x.passed)||
      proof.passed&&(proof.applicationErrors||!proof.invoked||!proof.cleanupPassed||
       !setup.every(x=>x.passed)||!checks.every(x=>x.passed)))malformed();
  const expected=expectedCallsAgainstSdk(proof.expectedCalls,sdkCalls);
  // app-guide reports success of required *operations*, not merely
  // their attempts. A failed independent assertion can legitimately leave
  // proof.passed=false while the write itself succeeded.
  if(report.successfulExpectedOperations!==expected.successful||
     (!proof.invoked&&sdkCalls.length)||
     (proof.passed&&(!expected.countPassed||!expected.successful)))malformed();
  const fault=proof.appFault;
  if(fault!==undefined){
    if(!object(fault)||!['before-call','after-success'].includes(fault.mode)||
       !bool(fault.injected)||!bool(fault.sentToEmulator))malformed();
    safeOperation(fault.service,fault.operation);
  }
  return {format:'approved_app_guide_result',sourceSha256,caseSha256,
    emulatorVersion:version(proof.emulatorVersion),accountVerifiedInReport:'not_reported',
    setup,checks,cleanup,
    sdkCalls,sourceInvoked:proof.invoked,applicationErrors:proof.applicationErrors,
    cleanupPassed:proof.cleanupPassed,
    expectedCallsPass:expected.countPassed&&expected.successful,
    faultMode:fault?.mode||null};
}

/** Strict, value-free export from one recognized declarative report. */
export function createGapReproCapsule(report){
  if(!object(report))malformed();
  const input=report.mode==='local_application_before_after'
    ?compareReport(report):report.mode==='approved_trusted_app_case'
      ?guidedReport(report):rawReport(report);
  const {setup,checks,cleanup,sdkCalls}=input;
  const failed=flatFailed(checks);
  const primaryCheck=checks.find(c=>c.assertions.some(a=>a.observed==='fail')||!c.passed);
  const failure=primaryCheck ? {...firstFault(checks,'independent_check')}:
    firstFault(setup,'setup')||firstFault(cleanup,'cleanup');
  // In comparison reports, the verified summary omits the check operation.
  // A service is inferred only from a known structural assertion prefix and
  // confirmed by an observed SDK call; never invent a missing operation.
  const derivedService=failed[0]?.pathShape?.startsWith('Messages')?'sqs':
    failed[0]?.pathShape?.startsWith('Item')?'dynamodb':
    failed[0]?.pathShape==='ContentLength'?'s3':null;
  // Raw results have an explicit read-service. When a known structural
  // assertion prefix conflicts with it, the report is contradictory.
  if(primaryCheck?.service&&derivedService&&primaryCheck.service!==derivedService)malformed();
  const candidateService=primaryCheck?.service||derivedService;
  const matching=candidateService?sdkCalls.filter(c=>c.service===candidateService):[];
  // A single *unrelated* SDK call is not evidence that it caused a failed
  // read. An ambiguous or unmatched service must remain UNKNOWN/null.
  const selected=matching.length===1?matching[0]:null;
  const handlerOperation=selected ? selected.service+'.'+selected.operation:null;
  const failingReadOperation=primaryCheck?.service
    ? primaryCheck.service+'.'+primaryCheck.operation:null;
  const classification=classify(input);
  const compare=input.format==='app_case_comparison';
  const handler='TRUSTED_HANDLER.py',caseName='REVIEWED_CASE.json';
  const before='TRUSTED_BEFORE.py',after='TRUSTED_AFTER.py';
  const review=compare
    ? 'Review both locally owned Python revisions and the declarative case before reproducing.'
    :`node bin/aws-emulator-mcp.mjs app-guide "${handler}" "${caseName}" --json`;
  const command=compare
    ?`node bin/aws-emulator-mcp.mjs app-case-compare "${before}" "${after}" "${caseName}" --json`
    :`node bin/aws-emulator-mcp.mjs app-guide "${handler}" "${caseName}" --run --approve "EXACT_SOURCE_CASE_APPROVAL_TOKEN" --json`;
  return {
    schemaVersion:1,kind:'emulator_gap_reproduction_capsule',
    inputFormat:input.format,reportConfidence:'report_fields_checked_not_independently_attested',
    interpretation:{classification,emulatorIncompatibilityEstablished:false,
      productionAWSParityEstablished:false,
      recommendedTriage:input.comparisonFixed?'application_logic_first':'undetermined_check_application_case_and_emulator_support'},
    target:{handlerOperation,independentReadOperation:failingReadOperation,
      failedStage:failure,failedAssertions:failed.slice(0,8).map(({pathSha256,...safe})=>safe),
      observedSdkCalls:sdkCalls,cleanupPassed:input.cleanupPassed,
      applicationExceptionReported:input.applicationErrors,
      ...(input.faultMode?{syntheticFaultMode:input.faultMode}:{})},
    identities:{sourceSha256:input.sourceSha256,caseSha256:input.caseSha256,
      ...(compare?{otherSourceSha256:input.relatedSourceSha256,side:input.compareSide}:{})},
    emulator:{version:input.emulatorVersion,
      accountVerifiedInReport:input.accountVerifiedInReport,
      versionIndependentlyAttested:false},
    reproduction:{reviewCommandTemplate:review,runCommandTemplate:command,
      commandTemplatesRequireLocalFiles:true,requiresTrustedSourceReview:true,
      ...(compare?{requiresExplicitRunnerSelection:true}:{requiresExactSourceCaseApproval:true}),
      requiredAttachments:['trusted developer-selected Python source matching source SHA-256',
        'reviewed declarative JSON case matching case SHA-256',
        ...(compare?['other trusted Python revision matching other source SHA-256']:[])],
      notes:'Replace placeholder filenames with locally reviewed files. Export itself never runs code. A reproduced application failure is not automatically an emulator bug.'},
    redaction:{strictOutputAllowlist:true,rawInputsIncluded:false,expectedValuesIncluded:false,
      rawSourceIncluded:false,logsIncluded:false,pathsIncluded:false,credentialsIncluded:false},
    limitations:'Existing local report only; hashes and account flags are not re-attested without original inputs. Read the reviewed case for full expectation values; compare against documented emulator support. Do not file as confirmed AWS Emulator incompatibility without an independent minimal replay.'
  };
}

export function parseGapReproArgs(args){
  if(!Array.isArray(args)||args.length!==1||typeof args[0]!=='string')malformed();
  const filename=args[0];
  if(filename.length<1||filename.length>1024||!filename.toLowerCase().endsWith('.json')||
     filename.startsWith('-')||/^(?:https?|file):/i.test(filename)||
     /^[\\/]{2}/.test(filename)||/^\\(?:\?\?|Device\\|GLOBALROOT\\)/i.test(filename)||
     /[\r\n\0]/.test(filename))malformed();
  return filename;
}
export function readGapReport(filename){
  parseGapReproArgs([filename]);
  let fd;
  try{
    const before=lstatSync(filename);
    if(!before.isFile()||before.isSymbolicLink()||!integer(before.size,MAX_BYTES)||before.size<2)malformed();
    fd=openSync(filename,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0));
    const current=fstatSync(fd);
    if(!current.isFile()||current.ino!==before.ino||current.dev!==before.dev||
       current.size!==before.size)malformed();
    const data=Buffer.alloc(before.size);
    let cursor=0;
    while(cursor<data.length){
      const count=readSync(fd,data,cursor,data.length-cursor,null);
      if(count<=0)malformed();
      cursor+=count;
    }
    if(fstatSync(fd).size!==data.length)malformed();
    return JSON.parse(data.toString('utf8'));
  }catch{malformed();}
  finally{if(fd!==undefined)closeSync(fd);}
}
