/** Join static Python call discovery with independently executed, synthetic AWS API probes.
 * This module never executes application source. A matched API operation is not
 * evidence that an application's runtime branch, arguments or business logic ran.
 */
import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const OBSERVATIONS = new Set(['success', 'api_error', 'local_error', 'synthetic_sdk_timeout']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function planSha256(plan) {
  return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
}

function operationMethod(step) {
  return `${step.service}.${step.operation.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`;
}

/** Accept evidence only when it describes the exact submitted contract and
 * its executed prefix, including the failing step. A SHA-256 link is NOT an
 * authenticity signature: this checks consistency of local tool outputs.
 */
function readEvidence(draft, run) {
  if (run === undefined) return { status: 'not_run', steps: [] };
  const proof = run?.proof;
  const plan = draft.plan;
  const bad = { status: 'invalid_evidence', steps: [] };
  if (!run || ![0, 1].includes(run.code) || !proof || typeof proof !== 'object' ||
      proof.schemaVersion !== 1 || proof.name !== plan.name ||
      proof.planSha256 !== planSha256(plan) || !SHA256.test(proof.planSha256) ||
      proof.accountVerified !== true || typeof proof.emulatorVersion !== 'string' ||
      !proof.emulatorVersion || proof.emulatorVersion.length > 160 ||
      !Array.isArray(proof.steps) || proof.steps.length < 1 ||
      proof.steps.length > plan.steps.length ||
      proof.totalSteps !== plan.steps.length || !Number.isInteger(proof.passedSteps) ||
      typeof proof.passed !== 'boolean') return bad;

  let passedCount = 0;
  for (let i = 0; i < proof.steps.length; i++) {
    const actual = proof.steps[i], expected = plan.steps[i];
    if (!actual || actual.id !== expected.id || actual.service !== expected.service ||
        actual.operation !== expected.operation || typeof actual.passed !== 'boolean' ||
        !OBSERVATIONS.has(actual.observed) || !Array.isArray(actual.assertions)) return bad;
    if (actual.passed) passedCount++;
    // The runner stops at its first unexpected step.
    if (i < proof.steps.length - 1 && !actual.passed) return bad;
    const expectError = expected.expect?.errorCode;
    if (actual.observed === 'success') {
      if (!SHA256.test(actual.responseSha256 || '') ||
          actual.assertions.length !== (expected.expect?.assertions || []).length) return bad;
      for (let n = 0; n < actual.assertions.length; n++) {
        if (actual.assertions[n]?.path !== expected.expect.assertions[n].path ||
            typeof actual.assertions[n]?.passed !== 'boolean') return bad;
      }
      const shouldPass = !expectError && actual.assertions.every(x => x.passed);
      if (actual.passed !== shouldPass) return bad;
    } else {
      if (actual.assertions.length !== 0) return bad;
      const code = actual.observed === 'synthetic_sdk_timeout' ? 'RequestTimeout' : actual.errorCode;
      const shouldPass = (actual.observed === 'api_error' ||
          actual.observed === 'synthetic_sdk_timeout') && !!expectError && code === expectError;
      if (actual.passed !== shouldPass) return bad;
    }
  }
  const allPassed = passedCount === plan.steps.length;
  if (passedCount !== proof.passedSteps || proof.passed !== allPassed ||
      run.code !== (allPassed ? 0 : 1) ||
      proof.steps.length !== (allPassed ? plan.steps.length : passedCount + 1)) return bad;
  return {
    status: allPassed ? 'passed' : 'failed',
    steps: proof.steps.map(s => ({ id: s.id, method: operationMethod(s), passed: s.passed })),
    planSha256: proof.planSha256,
    emulatorVersion: proof.emulatorVersion,
    passedSteps: proof.passedSteps,
    totalSteps: proof.totalSteps,
  };
}

/** One deterministic, expectation-only negative control per synthetic plan.
 * Never modifies AWS parameters or application source. The runtime validates
 * the mutated data through the same existing contract worker.
 */
export function buildAssertionChallenge(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 16)
    return null;
  for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex++) {
    const assertions = plan.steps[stepIndex]?.expect?.assertions;
    if (!Array.isArray(assertions)) continue;
    for (let assertionIndex = 0; assertionIndex < assertions.length; assertionIndex++) {
      const assertion = assertions[assertionIndex];
      if (!assertion || !Object.hasOwn(assertion, 'equals')) continue;
      // Bounded test fixture: never use arbitrary source values or AWS responses.
      const mutated = structuredClone(plan);
      const expected = assertion.equals;
      const marker = '__mcp_negative_control__';
      const different = typeof expected === 'number' && Number.isSafeInteger(expected) &&
          expected < Number.MAX_SAFE_INTEGER
        ? expected + 1 : typeof expected === 'boolean' ? !expected
          : typeof expected === 'string' && Buffer.byteLength(expected, 'utf8') + marker.length <= 8192
            ? expected + marker : marker;
      mutated.steps[stepIndex].expect.assertions[assertionIndex].equals = different;
      return { plan: mutated, stepIndex, assertionIndex,
        stepId: mutated.steps[stepIndex].id, path: assertion.path };
    }
  }
  return null;
}

/** Verify the challenge failed on the chosen assertion—not due to a startup,
 * operation, cleanup, or other unrelated failure. SHA checks bind to the
 * mutated plan, while the baseline must also pass in its own fresh run.
 */
function summarizeChallenge(draft, baselineRun, controlRun) {
  const baseline = readEvidence(draft, baselineRun);
  const challenge = buildAssertionChallenge(draft.plan);
  if (baseline.status !== 'passed') return { status: 'baseline_not_passed' };
  if (!challenge) return { status: 'no_equality_assertion' };
  const details = { stepId: challenge.stepId, path: challenge.path,
    planSha256: planSha256(challenge.plan) };
  if (!controlRun) return { ...details, status: 'not_run' };
  const checked = readEvidence({ plan: challenge.plan }, controlRun);
  if (checked.status === 'invalid_evidence') return { ...details, status: 'invalid_evidence' };
  if (checked.status === 'passed') return { ...details, status: 'not_detected' };
  if (checked.status !== 'failed') return { ...details, status: 'inconclusive' };
  const steps = controlRun.proof.steps;
  const observed = steps[challenge.stepIndex];
  const assertions = observed?.assertions;
  const detected = steps.length === challenge.stepIndex + 1 &&
    steps.slice(0, -1).every(step => step.passed) &&
    observed?.id === challenge.stepId && observed?.observed === 'success' &&
    observed.passed === false && Array.isArray(assertions) &&
    assertions.length === draft.plan.steps[challenge.stepIndex].expect.assertions.length &&
    assertions[challenge.assertionIndex]?.path === challenge.path &&
    assertions.every((a, i) => a.passed === (i !== challenge.assertionIndex));
  if (!detected) return { ...details, status: 'inconclusive' };
  // Prevent comparing observations from different emulator releases.
  if (baseline.emulatorVersion !== checked.emulatorVersion)
    return { ...details, status: 'inconclusive' };
  return { ...details, status: 'detected' };
}

/** Standalone user-authored contract negative control. An emitted result is
 * never proof that application code was executed; only local SDK assertions.
 */
export function assessContractChallenge(plan, baselineRun, controlRun) {
  return summarizeChallenge({plan}, baselineRun, controlRun);
}

export function summarizeProjectProbes(inventory, runs = [], controlRuns = undefined) {
  if (!inventory || inventory.schemaVersion !== 1 || inventory.executed !== false ||
      !Array.isArray(inventory.calls) || inventory.calls.length > 256 ||
      !Array.isArray(inventory.drafts) || inventory.drafts.length > 4 ||
      !Array.isArray(inventory.skippedFiles) || !Array.isArray(inventory.analyzedFiles) ||
      !Array.isArray(inventory.unmatchedMethods) || !Array.isArray(runs) ||
      runs.length > inventory.drafts.length ||
      (controlRuns !== undefined && (!Array.isArray(controlRuns) ||
        controlRuns.length > inventory.drafts.length))) {
    throw new Error('Invalid or oversized project inventory');
  }
  const probes = inventory.drafts.map((draft, i) => {
    const evidence = readEvidence(draft, runs[i]);
    return {
      service: draft.service,
      ...(controlRuns !== undefined ? {
        assertionChallenge: summarizeChallenge(draft, runs[i], controlRuns[i]),
      } : {}),
      status: evidence.status,
      name: draft.plan.name,
      planSha256: planSha256(draft.plan),
      ...(evidence.emulatorVersion ? { emulatorVersion: evidence.emulatorVersion } : {}),
      ...(evidence.passedSteps !== undefined ? {
        passedSteps: evidence.passedSteps, totalSteps: evidence.totalSteps,
      } : {}),
      steps: evidence.steps,
    };
  });
  const callSites = inventory.calls.map(call => {
    const i = inventory.drafts.findIndex(d => d.matchedMethods.includes(call.method));
    const draft = i < 0 ? null : inventory.drafts[i];
    const probe = i < 0 ? null : probes[i];
    const matchingSteps = probe?.steps.filter(step => step.method === call.method) || [];
    const expectedSteps = draft?.plan.steps.filter(step => operationMethod(step) === call.method) || [];
    let status = 'not_covered';
    if (probe) {
      if (probe.status === 'not_run') status = 'not_run';
      else if (probe.status === 'invalid_evidence') status = 'invalid_evidence';
      else if (matchingSteps.some(step => !step.passed)) status = 'api_probe_failed';
      else if (matchingSteps.length === expectedSteps.length &&
               matchingSteps.every(step => step.passed)) status = 'api_probe_passed';
      else status = 'not_reached';
    }
    const gap = draft?.argumentGaps?.find(g => g.file === call.file &&
      g.line === call.line && g.method === call.method);
    return {
      file: call.file, line: call.line, method: call.method, status,
      unexercisedKeywords: gap?.unexercisedKeywords || [],
      unresolvedArguments: gap?.unresolvedArguments || false,
      argumentsNeedReview: !!gap,
      applicationBehaviorTested: false,
    };
  });
  const count = status => callSites.filter(call => call.status === status).length;
  const summary = {
    callSites: callSites.length,
    apiProbePassed: count('api_probe_passed'),
    apiProbeFailed: count('api_probe_failed'),
    untested: callSites.length - count('api_probe_passed') - count('api_probe_failed'),
    argumentReviewNeeded: callSites.filter(call => call.argumentsNeedReview).length,
    skippedFiles: inventory.skippedFiles.length,
    successfulContracts: probes.filter(p => p.status === 'passed').length,
    failedContracts: probes.filter(p => p.status === 'failed' || p.status === 'invalid_evidence').length,
    ...(controlRuns !== undefined ? {
      challengesDetected: probes.filter(p => p.assertionChallenge.status === 'detected').length,
      challengesUnverified: probes.filter(p => p.assertionChallenge.status !== 'detected').length,
    } : {}),
  };
  return {
    schemaVersion: 1,
    mode: controlRuns !== undefined ? 'assertion_challenge' :
      runs.length ? 'synthetic_probes' : 'static_inventory',
    sourceExecution: false,
    applicationFixVerified: false,
    productionAwsValidated: false,
    sourceFiles: inventory.analyzedFiles,
    skippedFiles: inventory.skippedFiles,
    unmatchedMethods: inventory.unmatchedMethods,
    summary, probes, callSites,
    status: summary.apiProbeFailed || summary.failedContracts ? 'api_probe_failed'
      : controlRuns !== undefined && probes.some(p =>
        ['not_detected', 'invalid_evidence'].includes(p.assertionChallenge.status))
        ? 'challenge_failed'
        : summary.callSites === 0 || summary.untested || summary.skippedFiles ||
          summary.argumentReviewNeeded || (controlRuns !== undefined && summary.challengesUnverified)
          ? 'incomplete' : controlRuns !== undefined ? 'assertion_challenges_passed' : 'api_probes_passed',
    limitations: 'Only direct statically recognized Python Boto3 client calls; synthetic AWS Emulator SDK probes. '
      + 'Application code, branches, values, business assertions, IAM and production AWS were NOT tested. '
      + 'One negative control per generated plan only; a detected mismatch does not prove application behavior. '
      + 'SHA-256 links local plans and evidence but does not authenticate saved artifacts.',
  };
}

export function formatProjectCheck(report) {
  const s = report.summary;
  const lines = [
    'AWS EMULATOR MCP / PROJECT CHECK',
    '',
    `Direct Python Boto3 call sites: ${s.callSites}`,
    `Synthetic API probe passed: ${s.apiProbePassed} | failed: ${s.apiProbeFailed} | untested: ${s.untested}`,
    `Arguments needing review: ${s.argumentReviewNeeded} | skipped files: ${s.skippedFiles}`,
    '',
  ];
  for (const call of report.callSites) {
    const gap = call.argumentsNeedReview ? ' [REVIEW ARGUMENTS]' : '';
    lines.push(`  ${call.status.toUpperCase().padEnd(17)} ${call.file}:${call.line}  ${call.method}${gap}`);
  }
  for (const probe of report.probes) {
    lines.push(`  ${probe.service} plan: ${probe.status} (${probe.name})`);
    if (probe.assertionChallenge) {
      const control = probe.assertionChallenge;
      lines.push(`    Assertion challenge: ${control.status}` +
        (control.stepId ? ` at ${control.stepId}.${control.path}` : ''));
    }
  }
  lines.push('', 'APP FIX NOT VERIFIED — tests use synthetic input, not the application.',
    'Review missing operations and arguments; use your own runtime/business assertions.',
    'A detected negative control proves one synthetic assertion is sensitive to a mismatch, not the app.',
    'No real AWS calls or production credentials.');
  return lines.join('\n') + '\n';
}
