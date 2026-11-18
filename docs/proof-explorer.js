/**
 * Static evidence reader, not a live emulator or an attestation service.
 * Fixed first-party paths only. Never executes Python or sends AWS API calls.
 */
const SNAPSHOTS = Object.freeze({
  sqs: {
    file: 'evidence/app-case-aws-emulator-1.0.506.json',
    sourceCase: 'examples/app-case/sqs-idempotency.json',
    description: 'Two identical application requests must produce one fulfillment event. The regression is a second SQS message.',
    compare: 'node bin/aws-emulator-mcp.mjs app-case-compare examples/app-case/buggy.py examples/app-case/fixed.py examples/app-case/sqs-idempotency.json --json',
    inspect: 'node bin/aws-emulator-mcp.mjs app-case-inspect examples/app-case/fixed.py examples/app-case/sqs-idempotency.json --json',
  },
  s3: {
    file: 'evidence/app-case-s3-aws-emulator-1.0.506.json',
    sourceCase: 'examples/app-case/s3-object-write.json',
    description: 'A trusted Python upload should store a 12-byte object, not 13 bytes. An independent HeadObject response checks ContentLength.',
    compare: 'node bin/aws-emulator-mcp.mjs app-case-compare examples/app-case/s3-upload-bug.py examples/app-case/s3-upload.py examples/app-case/s3-object-write.json --json',
    inspect: 'node bin/aws-emulator-mcp.mjs app-case-inspect examples/app-case/s3-upload.py examples/app-case/s3-object-write.json --json',
  }
});
const BASE_COMMIT = 'bb24ec7b755defefff78b79df7807e9533a08ec8';
const SHA = /^[a-f0-9]{64}$/;

function assertionList(side) {
  if (!side || !Array.isArray(side.checks) || !side.checks.length) return null;
  const values = [];
  for (const check of side.checks) {
    if (!check || typeof check.id !== 'string' || !Array.isArray(check.assertions) || !check.assertions.length) return null;
    let valid = true;
    for (const item of check.assertions) {
      if (!item || typeof item.path !== 'string' || typeof item.passed !== 'boolean') return null;
      values.push({name: check.id + '.' + item.path, passed: item.passed});
      valid = valid && item.passed;
    }
    if (check.passed !== valid) return null;
  }
  return values;
}

function rawCleanupMatches(raw, summarized) {
  // The full project-maintained SQS record retains the actual SDK teardown
  // responses. Do not let a green comparison summary conceal a failed or
  // missing cleanup step in that underlying run.
  if (!Array.isArray(raw.cleanup) || raw.cleanup.length !== summarized.cleanup.length)
    return false;
  return raw.cleanup.every((step, index) =>
    step?.id === summarized.cleanup[index].id &&
    step.passed === true && summarized.cleanup[index].passed === true &&
    step.observed === 'success' && SHA.test(step.responseSha256 || ''));
}

/**
 * Fail closed for a missing or contradictory saved report.
 * This is a consistency check over project-authored JSON, NOT independent
 * verification of AWS Emulator identity, signed binaries, or AWS parity.
 */
export function validateEvidence(record) {
  const c = record && record.comparison;
  const no = reason => ({ok: false, reason});
  if (!record || record.schemaVersion !== 1 || !/^\d{4}-\d\d-\d\d$/.test(record.recordedDate || '') ||
      !c || c.schemaVersion !== 1 || c.mode !== 'local_application_before_after' ||
      !c.passed || c.bugReproduced !== true || c.fixVerified !== true ||
      c.accountVerified !== true || c.applicationBehaviorTested !== true ||
      c.productionAwsValidated !== false || typeof c.emulatorVersion !== 'string' ||
      !c.emulatorVersion || typeof c.case !== 'string' || !SHA.test(c.caseSha256 || '')) {
    return no('Missing or inconsistent application proof metadata');
  }
  const before = c.before, after = c.after;
  if (!before || !after || before.passed !== false || after.passed !== true ||
      before.invoked !== true || after.invoked !== true ||
      before.applicationErrors !== false || after.applicationErrors !== false ||
      before.cleanupPassed !== true || after.cleanupPassed !== true ||
      !SHA.test(before.sourceSha256 || '') || !SHA.test(after.sourceSha256 || '') ||
      before.sourceSha256 === after.sourceSha256 ||
      before.emulatorVersion !== c.emulatorVersion || after.emulatorVersion !== c.emulatorVersion) {
    return no('Source, execution, emulator, or cleanup evidence does not match');
  }
  for (const side of [before, after]) {
    if (!Array.isArray(side.cleanup) || !side.cleanup.length ||
        side.cleanup.some(x => !x || x.passed !== true) ||
        !Array.isArray(side.sdkCalls) || !Array.isArray(side.expectedCalls) ||
        side.expectedCalls.some(x => !x || x.passed !== true)) {
      return no('Missing cleanup or application SDK call-count evidence');
    }
    if (side.sdkCalls.some(x => !x || !Number.isInteger(x.attempts) ||
        !Number.isInteger(x.successes) || x.successes < 0 ||
        x.successes > x.attempts || typeof x.service !== 'string' ||
        typeof x.operation !== 'string')) {
      return no('Invalid observed application SDK counts');
    }
  }
  const b = assertionList(before), a = assertionList(after);
  if (!b || !a || b.length !== a.length ||
      b.some((v,i) => v.name !== a[i].name) ||
      a.some(x => !x.passed)) {
    return no('Independent assertion list is incomplete or changed');
  }
  const failed = b.filter(x => !x.passed);
  const reg = c.regression;
  if (failed.length !== 1 || !reg || failed[0].name !== reg.stepId + '.' + reg.path) {
    return no('Before run did not fail exactly the named regression assertion');
  }
  // Some saved records contain full raw before/after summaries and others only
  // the sanitized comparison. Validate those additional summaries when present.
  if ((record.before && (record.before.caseSha256 !== c.caseSha256 ||
        record.before.sourceSha256 !== before.sourceSha256 ||
        record.before.cleanupPassed !== true || record.before.passed !== false ||
        !rawCleanupMatches(record.before, before))) ||
      (record.after && (record.after.caseSha256 !== c.caseSha256 ||
        record.after.sourceSha256 !== after.sourceSha256 ||
        record.after.cleanupPassed !== true || record.after.passed !== true ||
        !rawCleanupMatches(record.after, after)))) {
    return no('Saved run summaries disagree with the comparison');
  }
  return {ok: true, beforeAssertions: b, afterAssertions: a};
}

function renderEvidence(doc, record, scenario, verified) {
  const c = record.comparison;
  const set = (id, value) => {doc.getElementById(id).textContent = String(value);};
  const count = xs => xs.filter(x => x.passed).length + '/' + xs.length;
  set('recorded-date', 'Recorded ' + record.recordedDate);
  set('emulator-version', c.emulatorVersion);
  set('regression-description', 'Expected failure: ' + c.regression.stepId + '.' + c.regression.path + ' in the before run only.');
  set('before-count', count(verified.beforeAssertions));
  set('after-count', count(verified.afterAssertions));
  set('before-invoked', 'YES'); set('after-invoked', 'YES');
  set('before-cleanup', 'PASS'); set('after-cleanup', 'PASS');
  set('before-result', 'FAIL (as expected)');
  set('after-result', 'PASS');
  set('case-hash', c.caseSha256);
  set('before-source', c.before.sourceSha256);
  set('after-source', c.after.sourceSha256);
  const rows = doc.getElementById('assertions');
  rows.replaceChildren();
  verified.beforeAssertions.forEach((item, index) => {
    const tr = doc.createElement('tr');
    const values = [item.name, item.passed ? 'PASS' : 'FAIL', verified.afterAssertions[index].passed ? 'PASS' : 'FAIL'];
    values.forEach((value, cellIndex) => {
      const td = doc.createElement(cellIndex === 0 ? 'th' : 'td');
      if (cellIndex === 0) td.scope = 'row';
      else td.className = value === 'PASS' ? 'pass' : 'fail';
      td.textContent = value;
      tr.append(td);
    });
    rows.append(tr);
  });
  const calls = doc.getElementById('sdk-calls');
  calls.replaceChildren();
  const keys = new Map();
  for (const side of ['before','after']) {
    c[side].sdkCalls.forEach(x => {
      const key = x.service + '.' + x.operation;
      if (!keys.has(key)) keys.set(key, {before: 0, after: 0});
      keys.get(key)[side] = x.successes;
    });
  }
  for (const [key, value] of keys) {
    const tr = doc.createElement('tr');
    for (const text of [key, String(value.before), String(value.after)]) {
      const td = doc.createElement('td'); td.textContent = text; tr.append(td);
    }
    calls.append(tr);
  }
  set('compare-command', scenario.compare);
  set('inspect-command', scenario.inspect);
  doc.getElementById('raw-evidence').href = scenario.file;
  doc.getElementById('case-source').href =
    'https://github.com/B11-Health/aws-emulator-mcp/blob/' + BASE_COMMIT + '/' + scenario.sourceCase;
  doc.getElementById('record').hidden = false;
}

async function loadScenario(doc, key, revision) {
  const choice = SNAPSHOTS[key];
  const loading = doc.getElementById('loading');
  doc.getElementById('record').hidden = true;
  loading.hidden = false;
  loading.classList.remove('error');
  loading.textContent = 'Loading checked-in, project-maintained evidence...';
  doc.getElementById('scenario-description').textContent = choice.description;
  try {
    const response = await fetch(choice.file, {cache: 'no-store'});
    if (!response.ok) throw new Error('Recorded JSON unavailable (HTTP ' + response.status + ')');
    const data = await response.json();
    if (revision !== doc.body.dataset.proofRevision) return;
    const result = validateEvidence(data);
    if (!result.ok) throw new Error(result.reason);
    if (data.comparison.case !== (key === 'sqs' ? 'sqs-idempotent-retry' : 'independent-s3-object-write'))
      throw new Error('Unexpected case in evidence file');
    renderEvidence(doc, data, choice, result);
    loading.hidden = true;
  } catch (error) {
    if (revision !== doc.body.dataset.proofRevision) return;
    loading.classList.add('error');
    loading.textContent = 'Cannot show verified comparison: ' + (error instanceof Error ? error.message : 'invalid evidence') +
      '. Inspect the raw JSON and recorded run manually. No success should be inferred.';
  }
}
if (typeof document !== 'undefined') {
  const picker = document.getElementById('scenario');
  let revision = 0;
  const activate = () => {
    revision += 1;
    document.body.dataset.proofRevision = String(revision);
    void loadScenario(document, picker.value, String(revision));
  };
  picker.addEventListener('change', activate);
  activate();
}
