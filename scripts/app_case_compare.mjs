/** Compare developer-approved local Python application scenarios against a
 * single reviewed JSON case. This is not an MCP/PR source-execution surface.
 * Proof is bounded and redacted, with no raw parameters or application logs.
 */
import { planSha256 } from './project_check.mjs';

const SHA = /^[a-f0-9]{64}$/;

function checkStage(records, spec) {
  if (!Array.isArray(records) || records.length > spec.length) return false;
  for (let i = 0; i < records.length; i++) {
    const r = records[i], s = spec[i];
    if (!r || r.id !== s.id || r.service !== s.service || r.operation !== s.operation ||
        typeof r.passed !== 'boolean' || !Array.isArray(r.assertions) ||
        r.assertions.length > (s.expect?.assertions || []).length) return false;
    if (r.observed === 'success') {
      if (!SHA.test(r.responseSha256 || '') ||
          r.assertions.length !== (s.expect?.assertions || []).length ||
          r.assertions.some((a,j) => a.path !== s.expect.assertions[j].path ||
            typeof a.passed !== 'boolean') ||
          r.passed !== r.assertions.every(a => a.passed)) return false;
    } else if (!['api_error','local_error'].includes(r.observed) ||
               r.passed || r.assertions.length) return false;
  }
  return true;
}

export function verifyAppCaseProof(proof, sourceSha, spec, exitCode) {
  if (!proof || typeof proof !== 'object' || proof.schemaVersion !== 1 ||
      proof.case !== spec.name || proof.sourceSha256 !== sourceSha ||
      !SHA.test(proof.sourceSha256 || '') || proof.caseSha256 !== planSha256(spec) ||
      proof.accountVerified !== true || typeof proof.emulatorVersion !== 'string' ||
      !proof.emulatorVersion || proof.emulatorVersion.length > 120 ||
      proof.sourceExecution !== 'trusted_local_opt_in' ||
      proof.productionAwsValidated !== false ||
      typeof proof.sourceInvoked !== 'boolean' ||
      typeof proof.applicationErrors !== 'boolean' ||
      typeof proof.applicationInvariantPassed !== 'boolean' ||
      typeof proof.cleanupPassed !== 'boolean' || typeof proof.passed !== 'boolean' ||
      !checkStage(proof.setup,spec.setup) || !checkStage(proof.checks,spec.checks) ||
      !checkStage(proof.cleanup,spec.cleanup) ||
      !Array.isArray(proof.sdkCalls) || proof.sdkCalls.length > 24 ||
      !Array.isArray(proof.expectedCalls) ||
      proof.expectedCalls.length !== spec.invoke.expectedCalls.length) {
    throw Error('Missing or inconsistent application case evidence');
  }
  const actual = new Map();
  for (const c of proof.sdkCalls) {
    if (!c || typeof c.service !== 'string' || typeof c.operation !== 'string' ||
        !Number.isInteger(c.attempts) || !Number.isInteger(c.successes) ||
        c.attempts < 0 || c.successes < 0 || c.successes > c.attempts ||
        c.attempts > 1000 || actual.has(c.service+'.'+c.operation))
      throw Error('Malformed observed AWS SDK counts');
    actual.set(c.service+'.'+c.operation,c);
  }
  const faultSpec = spec.invoke.fault;
  let fault = null;
  if (faultSpec) {
    const raw = proof.appFault;
    const fields = ['service','operation','mode','occurrence','attemptsSeen',
      'injected','sentToEmulator','exceptionType','source'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.keys(raw).sort().join('|') !== fields.sort().join('|') ||
        raw.service !== faultSpec.service || raw.operation !== faultSpec.operation ||
        raw.mode !== faultSpec.mode || raw.occurrence !== faultSpec.occurrence ||
        raw.source !== 'local_sdk_wrapper' || raw.exceptionType !== 'ReadTimeoutError' ||
        typeof raw.injected !== 'boolean' || typeof raw.sentToEmulator !== 'boolean' ||
        !Number.isInteger(raw.attemptsSeen) || raw.attemptsSeen < 0 ||
        raw.attemptsSeen > 1000 ||
        raw.sentToEmulator !== (raw.injected && raw.mode === 'after-success'))
      throw Error('Missing or inconsistent application fault evidence');
    const observed = actual.get(raw.service+'.'+raw.operation);
    if (raw.attemptsSeen !== (observed?.attempts || 0) ||
        raw.injected !== (raw.attemptsSeen >= raw.occurrence) ||
        (raw.injected && raw.mode === 'before-call' && observed.successes >= observed.attempts) ||
        (raw.injected && raw.mode === 'after-success' && observed.successes < 1))
      throw Error('Application fault was not observed at the claimed SDK attempt');
    fault = {service:raw.service,operation:raw.operation,mode:raw.mode,
      occurrence:raw.occurrence, injected:raw.injected,
      sentToEmulator:raw.sentToEmulator};
  } else if (proof.appFault !== undefined) {
    throw Error('Unrequested application fault evidence');
  }
  // Observed calls can only originate from the explicitly invoked function:
  // setup/check/cleanup never use the observed client proxies.
  if (!proof.sourceInvoked && proof.sdkCalls.length)
    throw Error('SDK calls reported without an invoked source function');
  for (let i = 0; i < spec.invoke.expectedCalls.length; i++) {
    const ref = spec.invoke.expectedCalls[i], rec = proof.expectedCalls[i];
    const call = actual.get(ref.service+'.'+ref.operation);
    const observed = call?.attempts || 0;
    // This field confirms the declared *attempt count*. Successful SDK calls
    // are checked separately in the application invariant, so a deliberately
    // faulted baseline can retain valid call-count evidence without going green.
    const validated = ref.min <= observed && observed <= ref.max;
    if (!rec || rec.service !== ref.service || rec.operation !== ref.operation ||
        rec.min !== ref.min || rec.max !== ref.max || rec.observed !== observed ||
        rec.passed !== validated)
      throw Error('SDK call-count evidence mismatch');
  }
  const all = v => v.every(row => row.passed);
  const cleanup = proof.cleanup.length === spec.cleanup.length && all(proof.cleanup);
  const successfulExpectedCalls = spec.invoke.expectedCalls.every(ref =>
    (actual.get(ref.service+'.'+ref.operation)?.successes || 0) > 0);
  const invariant = proof.sourceInvoked && !proof.applicationErrors &&
      proof.setup.length === spec.setup.length && all(proof.setup) &&
      proof.checks.length === spec.checks.length && all(proof.checks) &&
      all(proof.expectedCalls) && successfulExpectedCalls &&
      (!faultSpec || fault.injected);
  if (proof.cleanupPassed !== cleanup || proof.applicationInvariantPassed !== invariant ||
      proof.passed !== (cleanup && invariant) || exitCode !== (proof.passed ? 0 : 1)) {
    throw Error('Contradictory application success or process exit evidence');
  }
  return {
    sourceSha256: sourceSha, emulatorVersion: proof.emulatorVersion,
    invoked: proof.sourceInvoked, applicationErrors: proof.applicationErrors,
    passed: proof.passed, cleanupPassed: proof.cleanupPassed,
    ...(fault ? {appFault:fault} : {}),
    sdkCalls: proof.sdkCalls.map(c=>({service:c.service,operation:c.operation,
      attempts:c.attempts,successes:c.successes})),
    setup: proof.setup.map(r=>({id:r.id,passed:r.passed})),
    checks: proof.checks.map(r=>({id:r.id,passed:r.passed,
      assertions:r.assertions.map(a=>({path:a.path,passed:a.passed}))})),
    cleanup: proof.cleanup.map(r=>({id:r.id,passed:r.passed})),
    expectedCalls: proof.expectedCalls.map(r=>({service:r.service,operation:r.operation,
      passed:r.passed,observed:r.observed})),
  };
}

export function compareAppCaseEvidence(beforeProof, beforeSha, beforeExit,
                                        afterProof, afterSha, afterExit, spec) {
  if (!SHA.test(beforeSha) || !SHA.test(afterSha) || beforeSha === afterSha)
    throw Error('Choose two distinct SHA-256-verified local source files');
  const before = verifyAppCaseProof(beforeProof,beforeSha,spec,beforeExit);
  const after = verifyAppCaseProof(afterProof,afterSha,spec,afterExit);
  if (before.emulatorVersion !== after.emulatorVersion)
    throw Error('Before/after runs need the same AWS Emulator version');
  const regression = spec.regression;
  const failures = before.checks.flatMap(check => check.assertions
    .filter(a=>!a.passed).map(a=>({id:check.id,path:a.path})));
  const beforeChecksReached = before.checks.length === spec.checks.length &&
    before.checks.every((check,i)=> check.id === spec.checks[i].id);
  const noUnrelatedFailures = before.setup.length===spec.setup.length &&
    before.setup.every(x=>x.passed) && !before.applicationErrors &&
    before.invoked && before.cleanupPassed && before.expectedCalls.every(x=>x.passed) &&
    before.checks.every(c=> c.passed === c.assertions.every(a=>a.passed));
  const bugReproduced = !before.passed && beforeChecksReached && noUnrelatedFailures &&
    (!spec.invoke.fault || before.appFault?.injected === true) &&
    failures.length===1 && failures[0].id===regression.stepId && failures[0].path===regression.path;
  const fixVerified = after.passed && after.cleanupPassed && !after.applicationErrors &&
    (!spec.invoke.fault || after.appFault?.injected === true) &&
    after.checks.length===spec.checks.length && after.checks.every(c=>c.passed);
  return {
    schemaVersion:1, mode:'local_application_before_after', case:spec.name,
    caseSha256:planSha256(spec),
    passed:bugReproduced && fixVerified,
    bugReproduced, fixVerified, accountVerified:true,
    emulatorVersion:before.emulatorVersion, regression,
    before, after,
    applicationBehaviorTested:true, productionAwsValidated:false,
    dataExposure:'Source, application inputs, private file paths, API parameters, API bodies, logs and exception messages omitted',
    limitations:'One selected trusted Python entrypoint, bounded synthetic case, independent local SDK checks and observed SDK call counts. Not hostile-code security, full codebase coverage, process-crash proof, AWS IAM or production fidelity.'
  };
}

export function appCaseMarkdown(r) {
  const fmt = ok => ok ? 'PASS':'FAIL';
  const checks = side => side.checks.flatMap(c=>c.assertions).filter(a=>a.passed).length;
  const total = side => side.checks.flatMap(c=>c.assertions).length;
  return [
    `### AWS Emulator MCP — trusted application test: ${r.case.replace(/[|\r\n]/g,' ')}`,
    '', `**${fmt(r.passed)}** — regression reproduced: ${fmt(r.bugReproduced)}; fix verified: ${fmt(r.fixVerified)}`,
    '', '| Evidence | Before | After |','| --- | --- | --- |',
    `| Developer source hash | \`${r.before.sourceSha256}\` | \`${r.after.sourceSha256}\` |`,
    `| Independent assertions | ${checks(r.before)}/${total(r.before)} | ${checks(r.after)}/${total(r.after)} |`,
    `| Scoped cleanup | ${fmt(r.before.cleanupPassed)} | ${fmt(r.after.cleanupPassed)} |`,
    ...(r.before.appFault ? [
      `| Synthetic ${r.before.appFault.mode} SDK fault (${r.before.appFault.service}.${r.before.appFault.operation}) | ${fmt(r.before.appFault.injected)} | ${fmt(r.after.appFault.injected)} |`
    ] : []),
    '', `**Expected regression:** ${r.regression.stepId}.${r.regression.path}`,
    `**Case hash:** \`${r.caseSha256}\``,
    `**Emulator:** ${r.emulatorVersion.replace(/[|\r\n]/g,' ')}`,
    '', `**Limits:** ${r.limitations}`,
    '', '_Local developer-selected trusted code; not an independently audited app or production AWS validation._',''
  ].join('\n');
}
