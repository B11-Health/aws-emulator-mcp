/**
 * Read-only app-case guidance and explicit, digest-bound approval tokens.
 * Importing this module cannot execute user source, start Docker or write files.
 * Actual trusted-local execution is delegated to the existing app-case runner.
 */
import {createHash} from 'node:crypto';
import {openSync, writeFileSync, closeSync, fstatSync, lstatSync, unlinkSync} from 'node:fs';

const SHA = /^[a-f0-9]{64}$/;
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED = /REVIEW_ME|REPLACE_WITH_SYNTHETIC_VALUE/i;
const KNOWN = new Set(['--json','--draft','--draft-proof','--run','--approve']);
const ALLOWED_CASE_FIELDS = [
  'schemaVersion','name','services','setup','invoke','checks','cleanup','regression'];

function selectedFile(value, suffix) {
  return typeof value === 'string' && value.length > 0 && value.length <= 260 &&
    value.endsWith(suffix) && !value.startsWith('-') && !/^(?:https?|file):/i.test(value) &&
    !/[\r\n\0]/.test(value);
}

export function parseAppGuideArgs(args) {
  if (!Array.isArray(args)) throw Error('Invalid app guide arguments');
  const selected = {source:null, caseFile:null, json:false, draft:null, proofDraft:null, run:false, approval:null};
  const files=[];
  const seen=new Set();
  for(let i=0;i<args.length;i++) {
    const v=args[i];
    if(typeof v!=='string') throw Error('Invalid app guide arguments');
    if(v.startsWith('-')) {
      if(!KNOWN.has(v) || seen.has(v)) throw Error('Unknown or repeated app guide flag');
      seen.add(v);
      if(v==='--json') {selected.json=true;continue;}
      if(v==='--run') {selected.run=true;continue;}
      if(i+1>=args.length || args[i+1].startsWith('-')) throw Error('Flag requires a value');
      const next=args[++i];
      if(v==='--draft') selected.draft=next;
      else if(v==='--draft-proof') selected.proofDraft=next;
      else selected.approval=next;
    } else files.push(v);
  }
  if(files.length<1 || files.length>2 || !selectedFile(files[0],'.py') ||
     (files[1] && !selectedFile(files[1],'.json')) ||
     (selected.draft && !selectedFile(selected.draft,'.json')) ||
     (selected.proofDraft && !selectedFile(selected.proofDraft,'.json')) ||
     (selected.approval && !SHA.test(selected.approval)) ||
     (selected.run && (files.length!==2 || !selected.approval)) ||
     (!selected.run && selected.approval) ||
     (selected.draft && (selected.run || files.length!==1 || selected.proofDraft)) ||
     (selected.proofDraft && (selected.run || selected.approval || files.length!==1))) {
    throw Error('Usage: aws-emulator-mcp app-guide FILE.py [CASE.json] [--json | --draft NEW.json | --draft-proof NEW.json | --run --approve TOKEN]');
  }
  selected.source=files[0];
  selected.caseFile=files[1]||null;
  return selected;
}

export function approvalToken(sourceSha256,caseSha256) {
  if(!SHA.test(sourceSha256||'') || !SHA.test(caseSha256||''))
    throw Error('App guide approvals require verified source and case hashes');
  return createHash('sha256').update('aws-emulator-mcp:app-guide:v1\0'+sourceSha256+'\0'+caseSha256).digest('hex');
}

function caseReviewGaps(caseData,inspection) {
  if(!caseData || typeof caseData!=='object' || Array.isArray(caseData))
    return ['invalid_case_object'];
  const gaps=[];
  if(Object.keys(caseData).sort().join(',')!==[...ALLOWED_CASE_FIELDS].sort().join(',') ||
     caseData.schemaVersion!==1) gaps.push('unreviewed_or_unknown_case_fields');
  if(typeof caseData.name!=='string' || !caseData.name.trim() || caseData.name.length>80)
    gaps.push('invalid_case_name');
  if(!Array.isArray(caseData.services) || caseData.services.length<1 || caseData.services.length>4 ||
    new Set(caseData.services).size!==caseData.services.length) gaps.push('invalid_services');
  const all = ['setup','checks','cleanup'];
  for(const key of all) {
    if(!Array.isArray(caseData[key]) || caseData[key].length<1 || caseData[key].length>8)
      gaps.push('missing_'+key);
  }
  if(all.every(key=>Array.isArray(caseData[key])) && all.reduce((n,key)=>n+caseData[key].length,0)>16)
    gaps.push('too_many_steps');
  if(!caseData.invoke || typeof caseData.invoke!=='object' ||
     caseData.invoke.entrypoint!==inspection.entrypoint ||
     !Number.isInteger(caseData.invoke.times) || caseData.invoke.times<1 ||
     caseData.invoke.times>3 || !caseData.invoke.inputs ||
     typeof caseData.invoke.inputs!=='object' || Array.isArray(caseData.invoke.inputs) ||
     !Array.isArray(caseData.invoke.expectedCalls) ||
     caseData.invoke.expectedCalls.length<1 || caseData.invoke.expectedCalls.length>8)
    gaps.push('invalid_invocation');
  if(!caseData.regression || typeof caseData.regression.stepId!=='string' ||
    typeof caseData.regression.path!=='string' || !Array.isArray(caseData.checks) ||
    !caseData.checks.some(step=>step?.id===caseData.regression.stepId &&
       step?.expect?.assertions?.some(a=>a?.path===caseData.regression.path)))
    gaps.push('regression_assertion_not_defined');
  if(!Array.isArray(caseData.checks) || !caseData.checks.some(step=>
     Array.isArray(step?.expect?.assertions) && step.expect.assertions.length>0))
    gaps.push('no_independent_assertions');
  // Guard incomplete sketches even if a caller removes reviewRequired.
  if(RESERVED.test(JSON.stringify(caseData))) gaps.push('review_placeholders_remain');
  return gaps;
}

export function summarizeAppGuide(inspection, caseData=null, {schemaValidation=null,selectedCaseSha256=null}={}) {
  if(!inspection || typeof inspection!=='object' || !SHA.test(inspection.sourceSha256||'') ||
      !Array.isArray(inspection.calls) || !Array.isArray(inspection.unresolvedAccesses))
    throw Error('Static app inspection produced incomplete evidence');
  const gaps=[];
  if(!inspection.entrypointFound || !inspection.entrypointSignatureMatches)
    gaps.push('unsupported_python_entrypoint');
  if(inspection.calls.length<1) gaps.push('no_literal_sdk_calls');
  if(inspection.unresolvedAccesses.length) gaps.push('unresolved_client_or_input_access');
  if(!inspection.starterCase) gaps.push('no_supported_starter_case');
  if(caseData !== null) {
    if(!inspection.caseReview || !SHA.test(inspection.caseReview.caseSha256||''))
      gaps.push('missing_case_inspection');
    else {
      const check=inspection.caseReview;
      if(!check.entrypointMatches) gaps.push('entrypoint_mismatch');
      for(const key of ['missingInputKeys','callsWithoutExpectedCounters',
        'expectedCountersNotSeenInSyntax','discoveredServicesNotDeclared']) {
        if(!Array.isArray(check[key]) || check[key].length) gaps.push(key);
      }
    }
    gaps.push(...caseReviewGaps(caseData,inspection));
    // The case parsed for this review must be the exact bytes that both
    // independent Python processes inspected and formally validated.
    if(!SHA.test(selectedCaseSha256||'') ||
       selectedCaseSha256!==inspection.caseReview?.caseSha256 ||
       selectedCaseSha256!==schemaValidation?.caseSha256)
      gaps.push('selected_case_hash_mismatch');
    if(!schemaValidation || schemaValidation.valid!==true ||
       schemaValidation.schemaVersion!==1 ||
       schemaValidation.developerSourceExecuted!==false ||
       schemaValidation.awsApiCallsMade!==false ||
       schemaValidation.dockerStarted!==false ||
       schemaValidation.caseSha256!==inspection.caseReview?.caseSha256) {
      gaps.push('formal_case_schema_not_validated');
    }
  }
  const caseSha = caseData===null ? null : inspection.caseReview?.caseSha256||null;
  const readyForApproval=caseData!==null && gaps.length===0;
  return {
    schemaVersion:1, mode:'guided_app_case_review',
    status:caseData===null ? (inspection.starterCase?'draft_available':'unsupported_source') :
      readyForApproval?'explicit_approval_required':'review_required',
    readyForApproval, formalCaseSchemaValidated:caseData!==null &&
      !gaps.includes('formal_case_schema_not_validated') &&
      !gaps.includes('selected_case_hash_mismatch'),
    sourceSha256:inspection.sourceSha256, caseSha256:caseSha,
    entrypoint:inspection.entrypoint,
    operationCandidates:inspection.calls.map(call=>({service:call.service,
      operation:call.operationCandidate, line:call.line})),
    inputKeys:inspection.inputKeys,
    reviewGaps:[...new Set(gaps)],
    suggestedExamples:inspection.suggestedExamples||[],
    draftCase:caseData===null ? inspection.starterCase : null,
    approvalToken:readyForApproval ? approvalToken(inspection.sourceSha256,caseSha):null,
    nextStep: caseData===null ? 'Save a draft with --draft NEW_CASE.json, then author synthetic setup, independent assertions and cleanup.' :
      readyForApproval ? 'Review source and full case yourself. Only then use --run --approve TOKEN for one trusted-local Docker test; build the signed image separately if absent.' :
      'Resolve reviewGaps, add independent AWS state assertions and cleanup, and rescan; no source executed.',
    limitations:'Static literal-call inspection and offline declarative schema validation only. No proof of actual branch execution, AWS operation-model support, source safety or hostile-code isolation.',
    executedSource:false, executedAWSCalls:false, dockerStarted:false, productionAwsValidated:false,
    requiresHumanReview:true
  };
}

/** A green case must have at least one successful SDK call for each
 * required operation, not merely a caught error incrementing attempts.
 * This matches the fail-closed rule also proposed in QA PR #66/#68.
 */
export function requiredOperationsSucceeded(proof, caseData) {
  const expected=caseData?.invoke?.expectedCalls;
  if(!Array.isArray(expected) || expected.length===0 || !Array.isArray(proof?.sdkCalls))
    return false;
  return expected.every(ref=>proof.sdkCalls.some(call=>
    call?.service===ref.service && call?.operation===ref.operation &&
    Number.isInteger(call.successes) && Number.isInteger(call.attempts) &&
    call.successes>0 && call.successes<=call.attempts));
}

/** One reviewed literal write -> two editable, always-unexecutable case drafts.
 *  The AST cannot establish parameter relationships or eventual behavior.
 *  Every suggested fixture, assertion and cleanup step needs human review.
 */
export function buildProofDraftPair(inspection) {
  if (!inspection?.entrypointSignatureMatches || !inspection?.entrypointFound ||
      !Array.isArray(inspection.calls) || inspection.calls.length !== 1 ||
      !Array.isArray(inspection.unresolvedAccesses) || inspection.unresolvedAccesses.length ||
      !Array.isArray(inspection.inputKeys) || !inspection.starterCase?.reviewRequired)
    throw Error('One unambiguous literal SDK write is required for a review template');
  const [{service,operationCandidate:operation}] = inspection.calls;
  const kind = `${service}.${operation}`;
  const blueprints = {
    's3.PutObject': {
      setup:[{id:'bucket',service:'s3',operation:'CreateBucket',
        parameters:{Bucket:{$fixture:'bucket'}}}],
      checks:[{id:'observe',service:'s3',operation:'HeadObject',
        parameters:{Bucket:{$fixture:'bucket'},Key:'REVIEW_ME_SYNTHETIC_OBJECT_KEY'},
        expect:{assertions:[{path:'ContentLength',exists:true}]}}],
      cleanup:[{id:'remove-object',service:'s3',operation:'DeleteObject',
        parameters:{Bucket:{$fixture:'bucket'},Key:'REVIEW_ME_SYNTHETIC_OBJECT_KEY'}},
        {id:'remove-bucket',service:'s3',operation:'DeleteBucket',
        parameters:{Bucket:{$fixture:'bucket'}}}],
    },
    'sqs.SendMessage': {
      setup:[{id:'queue',service:'sqs',operation:'CreateQueue',
        parameters:{QueueName:{$fixture:'queue'}}}],
      checks:[{id:'observe',service:'sqs',operation:'ReceiveMessage',
        parameters:{QueueUrl:{$ref:'queue.QueueUrl'},MaxNumberOfMessages:10,WaitTimeSeconds:1},
        expect:{assertions:[{path:'Messages.0.Body',exists:true}]}}],
      cleanup:[{id:'remove-queue',service:'sqs',operation:'DeleteQueue',
        parameters:{QueueUrl:{$ref:'queue.QueueUrl'}}}],
    },
    'dynamodb.PutItem': {
      setup:[{id:'table',service:'dynamodb',operation:'CreateTable',
        parameters:{TableName:{$fixture:'table'},
          AttributeDefinitions:[{AttributeName:'id',AttributeType:'S'}],
          KeySchema:[{AttributeName:'id',KeyType:'HASH'}],
          BillingMode:'PAY_PER_REQUEST'}}],
      checks:[{id:'observe',service:'dynamodb',operation:'GetItem',
        parameters:{TableName:{$fixture:'table'},
          Key:{id:{S:{$fixture:'id'}}}},
        expect:{assertions:[{path:'Item.id.S',exists:true}]}}],
      cleanup:[{id:'remove-table',service:'dynamodb',operation:'DeleteTable',
        parameters:{TableName:{$fixture:'table'}}}],
    },
  };
  const blueprint = blueprints[kind];
  if (!blueprint) throw Error('No reviewable one-write state template for this SDK operation');
  const positive = {
    schemaVersion:1,name:'review-required-'+service+'-state',
    services:[service], setup:blueprint.setup,
    invoke:{entrypoint:inspection.entrypoint,times:1,
      inputs:Object.fromEntries(inspection.inputKeys.map(key=>
        [key,'REPLACE_WITH_SYNTHETIC_VALUE'])),
      expectedCalls:[{service,operation,min:1,max:1}]},
    checks:blueprint.checks,cleanup:blueprint.cleanup,
    regression:{stepId:'observe',path:blueprint.checks[0].expect.assertions[0].path},
    reviewRequired:true,
  };
  const expectedRed = structuredClone(positive);
  expectedRed.name='review-required-'+service+'-expected-red';
  // Flip exactly the same independently observable assertion. This must
  // fail for a *passing* baseline after the developer fills and reviews both
  // files; not an assertion that a particular application is already correct.
  expectedRed.checks[0].expect.assertions[0].exists=false;
  return {positive,expectedRed,operation:kind,
    assertion:positive.regression.stepId+'.'+positive.regression.path};
}

/** Create a positive + expected-red pair with no overwrites.
 *  If either create/write fails, roll back only files belonging to this call.
 */
export function writeProofDraftPairExclusive(filename, drafts) {
  if (!selectedFile(filename,'.json') ||
      !drafts?.positive?.reviewRequired || !drafts?.expectedRed?.reviewRequired)
    throw Error('Proof drafts require a local review-required JSON filename');
  const redFile=filename.slice(0,-5)+'.expected-red.json';
  if (!selectedFile(redFile,'.json') || redFile===filename)
    throw Error('Expected-red draft filename exceeds the local selection limit');
  const selected = [filename,redFile];
  const content=[drafts.positive,drafts.expectedRed].map(item=>JSON.stringify(item,null,2)+'\n');
  if(content.some(raw=>Buffer.byteLength(raw)>48*1024))
    throw Error('Review-required proof draft exceeds 48 KiB');
  const created=[];
  try {
    for(let i=0;i<selected.length;i++) {
      const fd=openSync(selected[i],'wx',0o600);
      const stat=fstatSync(fd);
      created.push({filename:selected[i],fd,dev:stat.dev,ino:stat.ino});
      writeFileSync(fd,content[i],{encoding:'utf8'});
    }
    return {draftWritten:true,expectedRedDraftWritten:true,
      approvalToken:null,executable:false,reviewRequired:true,
      operation:drafts.operation,independentAssertion:drafts.assertion};
  } catch(error) {
    // Close first for Windows; only unlink files created by this invocation.
    for (const item of created) {
      try { closeSync(item.fd); item.closed=true; } catch { /* Preserve failure. */ }
    }
    for (const item of created) {
      try {
        const now=lstatSync(item.filename);
        if(now.dev===item.dev && now.ino===item.ino) unlinkSync(item.filename);
      } catch { /* Preserve failure. */ }
    }
    throw error;
  } finally {
    for (const item of created) if (!item.closed) closeSync(item.fd);
  }
}

export function writeDraftExclusive(filename, starter) {
  if(!selectedFile(filename,'.json') || !starter || starter.reviewRequired!==true ||
    !Array.isArray(starter.checks) || starter.checks.length!==0 ||
    !Array.isArray(starter.cleanup) || starter.cleanup.length!==0) {
    throw Error('No safe review-required starter available');
  }
  const json=JSON.stringify(starter,null,2)+'\n';
  if(Buffer.byteLength(json)>48*1024) throw Error('Draft exceeds reviewable size');
  let fd;
  try {
    fd=openSync(filename,'wx',0o600); // Create only; never overwrite even a symlink.
    writeFileSync(fd,json,{encoding:'utf8'});
  } finally {
    if(fd!==undefined) closeSync(fd);
  }
  return {draftWritten:true, executable:false, reviewRequired:true};
}

export function formatAppGuide(report, {draftWritten=false,proofDraftWritten=false}={}) {
  const lines=['AWS Emulator MCP / guided Python app proof (read-only inspection)',
    '  Status: '+report.status,
    '  Selected source SHA-256: '+report.sourceSha256,
    '  Literal SDK operations: '+report.operationCandidates.map(c=>c.service+'.'+c.operation).join(', '),
    '  Recognized input keys: '+report.inputKeys.join(', ')];
  if(report.caseSha256) lines.push('  Selected case SHA-256: '+report.caseSha256);
  if(report.reviewGaps.length) lines.push('  Review gaps: '+report.reviewGaps.join(', '));
  if(draftWritten) lines.push('  A review-required, NON-EXECUTABLE draft case was created (no overwrite).');
  if(proofDraftWritten) lines.push('  Two NEW review-required, NON-EXECUTABLE case drafts created (positive and expected-red).',
    '  State assertion and setup/cleanup are suggestions, not verified app facts.',
    '  Edit and review both files independently; remove reviewRequired only after review.');
  if(report.approvalToken) {
    lines.push('  Approval token for exactly this source + case:',
      '  '+report.approvalToken,
      '  After personally reviewing both files, re-run with --run --approve TOKEN.');
  }
  lines.push('  NEXT: '+report.nextStep,
    '  Source was NOT imported or executed; AWS APIs NOT called; no Docker launched.',
    '  Copying a token does not establish source safety. Docker is not a hostile-code sandbox.','');
  return lines.join('\n');
}
