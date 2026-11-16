/* Assess two trusted local order-handler runs without reading source or AWS credentials.
 * The emulator checks themselves are performed in separate network-disabled
 * Docker containers by the existing app-verify worker. This module is pure.
 */
const OBSERVED = [
  'acceptedSubmissions', 'queueEvents', 'duplicateSuppressed',
  'dbOrderPresent', 'businessFieldsMatch', 'receiptMatches'
];
const LIMITS = 'Two trusted local Python order handlers, one completed-request retry per run, isolated AWS Emulator S3/DynamoDB/SQS only. Not a full app test runner, concurrent retry proof, production IAM check, AWS fidelity guarantee, transactional outbox, or safe execution of hostile code.';

function cleanRun(proof, expectedSha, code) {
  if (!proof || proof.schemaVersion !== 1 || proof.case !== 'local-order-handler' ||
      proof.sourceSha256 !== expectedSha || typeof proof.emulatorVersion !== 'string' ||
      !proof.emulatorVersion || proof.accountVerified !== true ||
      typeof proof.passed !== 'boolean' ||
      !Array.isArray(proof.assertions) || proof.assertions.length !== 8 ||
      !Array.isArray(proof.cleanup) || proof.cleanup.length !== 7 ||
      typeof proof.observed !== 'object' || !proof.observed ||
      proof.cleanup.some(c => typeof c.name !== 'string' || typeof c.passed !== 'boolean') ||
      proof.assertions.some(c => typeof c.name !== 'string' || typeof c.passed !== 'boolean')) {
    throw new Error('Handler returned incomplete or unverifiable sanitized evidence');
  }
  const observed = Object.fromEntries(OBSERVED.map(key => [key, proof.observed[key] ?? null]));
  if (!Number.isInteger(observed.acceptedSubmissions) ||
      !Number.isInteger(observed.queueEvents) ||
      ['duplicateSuppressed', 'dbOrderPresent', 'businessFieldsMatch', 'receiptMatches']
        .some(key => typeof observed[key] !== 'boolean')) {
    throw new Error('Handler evidence did not contain verified application outcomes');
  }
  return {
    sourceSha256: expectedSha,
    passed: proof.passed,
    workerExit: code,
    observed,
    assertions: proof.assertions.map(c => ({name: c.name, passed: c.passed})),
    cleanup: proof.cleanup.map(c => ({name: c.name, passed: c.passed})),
    cleanupPassed: proof.cleanup.every(c => c.passed),
  };
}

export function compareHandlerEvidence(beforeProof, beforeSha, beforeCode,
                                       afterProof, afterSha, afterCode) {
  if (beforeSha === afterSha || !/^[a-f0-9]{64}$/.test(beforeSha) ||
      !/^[a-f0-9]{64}$/.test(afterSha)) {
    throw new Error('Comparison requires two distinct SHA-256-verified sources');
  }
  const before = cleanRun(beforeProof, beforeSha, beforeCode);
  const after = cleanRun(afterProof, afterSha, afterCode);
  if (beforeProof.emulatorVersion !== afterProof.emulatorVersion) {
    throw new Error('Cannot compare runs against different AWS Emulator versions');
  }
  const b = before.observed, a = after.observed;
  const bugReproduced = beforeCode === 1 && before.passed === false &&
    before.cleanupPassed && b.acceptedSubmissions === 2 && b.queueEvents === 2 &&
    b.duplicateSuppressed === false && b.dbOrderPresent &&
    b.businessFieldsMatch && b.receiptMatches &&
    before.assertions.some(c => c.name === 'first submission accepted' && c.passed);
  const fixVerified = afterCode === 0 && after.passed === true && after.cleanupPassed &&
    after.assertions.every(c => c.passed) && a.acceptedSubmissions === 1 &&
    a.queueEvents === 1 && a.duplicateSuppressed === true && a.dbOrderPresent &&
    a.businessFieldsMatch && a.receiptMatches;
  return {
    schemaVersion: 1,
    case: 'local-order-handler-comparison',
    passed: bugReproduced && fixVerified,
    bugReproduced,
    fixVerified,
    accountVerified: true,
    emulatorVersion: beforeProof.emulatorVersion,
    before,
    after,
    limitations: LIMITS,
    dataExposure: 'Local source, input orders, SDK bodies, exception text and logs omitted',
  };
}

export function comparisonMarkdown(report) {
  const fmt = value => value === null || value === undefined ? 'N/A' : String(value);
  const pass = ok => ok ? 'PASS' : 'FAIL';
  const b = report.before, a = report.after;
  return [
    '### AWS Emulator MCP — local handler comparison',
    '',
    `**${pass(report.passed)}** — reproduced duplicate-order bug: ${pass(report.bugReproduced)}; verified fix: ${pass(report.fixVerified)}`,
    '',
    '| Measured value | Before | After |',
    '| --- | ---: | ---: |',
    `| Accepted submissions | ${fmt(b.observed.acceptedSubmissions)} | ${fmt(a.observed.acceptedSubmissions)} |`,
    `| SQS messages | ${fmt(b.observed.queueEvents)} | ${fmt(a.observed.queueEvents)} |`,
    `| Resource cleanup | ${pass(b.cleanupPassed)} | ${pass(a.cleanupPassed)} |`,
    `| Assertions passed | ${b.assertions.filter(x => x.passed).length}/8 | ${a.assertions.filter(x => x.passed).length}/8 |`,
    '',
    `Emulator version: ${report.emulatorVersion.replace(/[|\r\n]/g, ' ')}`,
    `Before SHA-256: \`${b.sourceSha256}\``,
    `After SHA-256: \`${a.sourceSha256}\``,
    '',
    `**Scope:** ${report.limitations}`,
    '',
    '_Project-maintained or developer-run local emulator evidence; not independent AWS production validation._',
    ''
  ].join('\n');
}
