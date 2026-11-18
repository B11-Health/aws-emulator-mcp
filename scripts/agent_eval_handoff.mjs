/** Framework-neutral, read-only agent-evaluation handoff over bundled local
 * AWS Emulator app-case evidence. NOT an AWS-Bench implementation or an
 * externally signed attestation. No Docker, credentials or outbound network.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareAppCaseEvidence, verifyAppCaseProof} from './app_case_compare.mjs';
import {planSha256} from './project_check.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SHA=/^[a-f0-9]{64}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
function assertions(rows) {
  const found=rows.flatMap(row=>row.assertions||[]);
  return {passed:found.filter(row=>row.passed).length,total:found.length};
}

export function toAgentEvaluationHandoff({caseSpec,record,sourceBefore,sourceAfter}) {
  if(!caseSpec || !record || !sourceBefore || !sourceAfter ||
     !Array.isArray(caseSpec.services) || !record.before || !record.after)
    throw Error('Evaluation needs a complete case, before/after evidence and source bytes');
  const beforeSha=digest(sourceBefore),afterSha=digest(sourceAfter);
  if(!SHA.test(beforeSha)||!SHA.test(afterSha)||beforeSha===afterSha)
    throw Error('The before/after sources must be different and SHA-256 verified');
  if(record.before.sourceSha256!==beforeSha || record.after.sourceSha256!==afterSha ||
     record.before.caseSha256!==planSha256(caseSpec) ||
     record.after.caseSha256!==planSha256(caseSpec))
    throw Error('Project evidence does not match the exact public inputs');
  const outcome=compareAppCaseEvidence(record.before,beforeSha,1,
                                      record.after,afterSha,0,caseSpec);
  const expectedRegression=caseSpec.regression;
  const namedFailure=outcome.before.checks.flatMap(c=>c.assertions
    .filter(a=>!a.passed).map(a=>({id:c.id,path:a.path})));
  // A benchmark adapter must not trust the user's own handler or a green
  // metadata flag. The before/after independent postconditions are the gate.
  const verified=outcome.passed && outcome.bugReproduced && outcome.fixVerified &&
    outcome.before.cleanupPassed && outcome.after.cleanupPassed &&
    namedFailure.length===1 && namedFailure[0].id===expectedRegression.stepId &&
    namedFailure[0].path===expectedRegression.path;
  return {
    schemaVersion:1,
    kind:'independent_local_agent_evaluation_handoff',
    compatibility:'Framework-neutral reference case; not an AWS-Bench task, benchmark score, AWS partnership, or official emulator test suite.',
    taskId:'sqs-idempotent-order-handler',
    source:'Project-maintained recorded local application evidence; no external attestation',
    emulator:{name:'AWS Emulator',version:outcome.emulatorVersion,
      locallyVerifiedAccount:outcome.accountVerified===true,
      productionAWSValidated:false},
    case:{name:caseSpec.name,sha256:planSha256(caseSpec),
      services:[...caseSpec.services],
      action:'Two invocations of the same trusted local order handler using synthetic inputs',
      postcondition:'Independent DynamoDB typed-value read and SQS message count/body checks',
      expectedRegression:{...expectedRegression}},
    candidate:{brokenSourceSha256:beforeSha,fixedSourceSha256:afterSha},
    observed:{before:{assertions:assertions(record.before.checks),
      sdkCalls:outcome.before.sdkCalls,cleanupPassed:outcome.before.cleanupPassed,
      passed:outcome.before.passed},
      after:{assertions:assertions(record.after.checks),
        sdkCalls:outcome.after.sdkCalls,cleanupPassed:outcome.after.cleanupPassed,
        passed:outcome.after.passed},
      namedRegressionObserved:namedFailure,
      bugReproduced:outcome.bugReproduced,fixVerified:outcome.fixVerified},
    result:{localEvaluationPassed:verified,
      positiveControlVerified:outcome.fixVerified,
      negativeControlDetected:outcome.bugReproduced,
      cleanupVerifiedBoth:outcome.before.cleanupPassed&&outcome.after.cleanupPassed},
    metadata:{recordedDate:record.recordedDate||null,
      localOnly:true,sourceExecutedDuringExport:false,awsCallsDuringExport:false,
      dockerUsedDuringExport:false,productionAWSValidated:false},
    limitations:'Only the recorded synthetic local app case. Not AWS-Bench compatibility, evaluator signing, IAM enforcement, deployment proof, emulator service fidelity outside tested behavior, or real AWS production validation.'
  };
}

export function readBundledHandoff() {
  const directory=path.join(ROOT,'examples/app-case');
  const evidence=JSON.parse(readFileSync(path.join(ROOT,
    'docs/evidence/app-case-aws-emulator-1.0.506.json'),'utf8'));
  const spec=JSON.parse(readFileSync(path.join(directory,'sqs-idempotency.json'),'utf8'));
  const before=readFileSync(path.join(directory,'buggy.py'));
  const after=readFileSync(path.join(directory,'fixed.py'));
  return toAgentEvaluationHandoff({caseSpec:spec,record:evidence,
    sourceBefore:before,sourceAfter:after});
}

export function handoffMarkdown(r) {
  const mark=x=>x?'PASS':'FAIL';
  return [
    '### Application-behavior evaluation handoff (independent reference case)',
    '',`**${mark(r.result.localEvaluationPassed)}** local recorded before/after verification`,
    '',`- AWS Emulator: ${r.emulator.version}`,
    `- Case: ${r.case.name} (SHA-256 ${r.case.sha256})`,
    `- Named regression: ${r.case.expectedRegression.stepId}.${r.case.expectedRegression.path}`,
    `- Before assertions: ${r.observed.before.assertions.passed}/${r.observed.before.assertions.total}`,
    `- After assertions: ${r.observed.after.assertions.passed}/${r.observed.after.assertions.total}`,
    `- Cleanup: ${mark(r.result.cleanupVerifiedBoth)} both runs`,
    '',`**Limits:** ${r.limitations}`,
    '',`**Compatibility:** ${r.compatibility}`,''].join('\n');
}

if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  const args=process.argv.slice(2);
  if(args.length>1 || (args.length===1 && !['--json','--markdown'].includes(args[0]))) {
    process.stderr.write('Usage: node scripts/agent_eval_handoff.mjs [--json|--markdown]\n');
    process.exitCode=2;
  } else {
    try {
      const report=readBundledHandoff();
      process.stdout.write(args[0]==='--markdown' ? handoffMarkdown(report)+'\n' :
        JSON.stringify(report,null,2)+'\n');
      if(!report.result.localEvaluationPassed) process.exitCode=1;
    }catch {
      process.stderr.write('Evaluation evidence was inconsistent or unavailable; no success claimed.\n');
      process.exitCode=2;
    }
  }
}
