import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { discoverContracts, runGate } from '../scripts/contract_pr_gate.mjs';

function withWorkspace(fn) {
  const home = mkdtempSync(path.join(tmpdir(), 'aws-pr-gate-test-'));
  const dir = path.join(home, 'contracts');
  mkdirSync(dir);
  const add = (name, plan = {
    schemaVersion: 1, name: 'synthetic', steps: [{ id: 'read', service: 's3', operation: 'ListBuckets' }]
  }) => writeFileSync(path.join(dir, name), JSON.stringify(plan));
  try { fn({ home, dir, add }); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

function proof(options = {}) {
  return {
    schemaVersion: 1, name: 'synthetic', passed: true, accountVerified: true,
    emulatorVersion: 'Version: 1.0.385',
    planSha256: 'a'.repeat(64), totalSteps: 2, passedSteps: 2,
    steps: [
      { id: 'sqs', service: 'sqs', operation: 'SendMessage', passed: true,
        observed: 'synthetic_sdk_timeout', errorCode: 'RequestTimeout',
        fault: { mode: 'after-success', sentToEmulator: true },
        // These intentionally sensitive raw data fields must never be copied.
        requestBody: 'PRIVATE_CANARY_PAYLOAD', result: 'PRIVATE_CANARY_PAYLOAD' },
      { id: 'retry', service: 'sqs', operation: 'SendMessage',
        passed: true, observed: 'success', output: 'PRIVATE_CANARY_PAYLOAD' }
    ],
    ...options
  };
}

function accept() {
  return { status: 0, stdout: JSON.stringify(proof()) };
}

test('success creates redacted reports and an actionable markdown summary', () => {
  withWorkspace(({ home, add }) => {
    add('02-retry.json'); add('01-baseline.json');
    const target = path.join(home, 'evidence');
    const summary = path.join(home, 'github-summary.md');
    const report = runGate({
      workspace: home, directory: 'contracts', outputDirectory: target,
      summaryPath: summary, invokeContract: accept
    });
    assert.equal(report.passed, true);
    assert.deepEqual(report.results.map(x => x.file),
      ['01-baseline.json', '02-retry.json']);
    assert.deepEqual(readdirSync(target).sort(),
      ['case-01.json', 'case-02.json', 'report.json', 'summary.md']);
    assert.equal(report.results[0].totalSteps, 2);
    assert.deepEqual(report.results[0].steps[0].fault,
      { mode: 'after-success', sentToEmulator: true, source: 'local SDK wrapper' });
    const output = readFileSync(path.join(target, 'report.json'), 'utf8');
    assert.doesNotMatch(output, /PRIVATE_CANARY_PAYLOAD/);
    assert.doesNotMatch(output, /requestBody/);
    const summaryText = readFileSync(summary, 'utf8');
    assert.match(summaryText, /2\/2 contracts passed/);
    assert.match(summaryText, /isolated local AWS Emulator/);
    assert.match(summaryText, /Download \*\*aws-emulator-contract-evidence\*\*/);
  });
});

test('mixed results run every plan but fail the aggregate gate', () => {
  withWorkspace(({ home, add }) => {
    add('1-good.json'); add('2-bad.json'); add('3-good.json');
    let calls = 0;
    const report = runGate({
      workspace: home, directory: 'contracts',
      outputDirectory: path.join(home, 'out'),
      invokeContract() {
        calls++;
        if (calls === 2) return { status: 1, stdout: JSON.stringify(
          proof({ passed: false, passedSteps: 1, steps: [
            { id: 'oops', service: 'sqs', operation: 'SendMessage',
              observed: 'api_error', passed: false, errorCode: 'NotImplemented' }
          ] })
        ) };
        return accept();
      }
    });
    assert.equal(report.passed, false);
    assert.equal(calls, 3);
    assert.deepEqual(report.results.map(x => x.passed), [true, false, true]);
    assert.match(readFileSync(path.join(home, 'out/summary.md'), 'utf8'), /2\/3 contracts passed/);
  });
});

test('a repeated local gate run does not leave stale per-case evidence', () => {
  withWorkspace(({ home, dir, add }) => {
    add('first.json'); add('second.json');
    const outputDirectory = path.join(home, 'evidence');
    assert.equal(runGate({ workspace: home, directory: 'contracts',
      outputDirectory, invokeContract: accept }).passed, true);
    assert.ok(readdirSync(outputDirectory).includes('case-02.json'));
    rmSync(path.join(dir, 'second.json'));
    assert.equal(runGate({ workspace: home, directory: 'contracts',
      outputDirectory, invokeContract: accept }).passed, true);
    assert.equal(readdirSync(outputDirectory).includes('case-02.json'), false);
  });
});

test('a zero exit cannot spoof success if evidence is inconsistent', () => {
  withWorkspace(({ home, add }) => {
    add('bogus.json');
    for (const candidate of [
      proof({ accountVerified: false }),
      proof({ totalSteps: 3 }),
      proof({ planSha256: 'bad' }),
      proof({ steps: [] }),
      proof({ steps: [{ id: 'fail', service: 's3', operation: 'PutObject', passed: false }] }),
      { passed: true, steps: 'not-an-array' },
    ]) {
      const result = runGate({
        workspace: home, directory: 'contracts',
        outputDirectory: path.join(home, 'evidence'),
        invokeContract: () => ({ status: 0, stdout: JSON.stringify(candidate) })
      });
      assert.equal(result.passed, false);
    }
  });
});

test('the runner never copies raw child stderr, stdout or secrets into reports', () => {
  withWorkspace(({ home, add }) => {
    add('error.json');
    const report = runGate({
      workspace: home, directory: 'contracts',
      outputDirectory: path.join(home, 'evidence'),
      invokeContract: () => ({
        status: 2, stdout: 'PRIVATE_SECRET_ERROR_from_server', stderr: 'PRIVATE_SECRET_ERROR'
      })
    });
    assert.equal(report.passed, false);
    assert.doesNotMatch(readFileSync(path.join(home, 'evidence/report.json'), 'utf8'),
      /PRIVATE_SECRET_ERROR/);
    assert.doesNotMatch(readFileSync(path.join(home, 'evidence/summary.md'), 'utf8'),
      /PRIVATE_SECRET_ERROR/);
  });
});

test('missing directory and empty folder fail closed with evidence and summary', () => {
  withWorkspace(({ home }) => {
    for (const folder of ['unknown', 'contracts']) {
      let invoked = 0;
      const result = runGate({
        workspace: home, directory: folder,
        outputDirectory: path.join(home, 'evidence'),
        invokeContract: () => { invoked++; return accept(); }
      });
      assert.equal(result.passed, false);
      assert.equal(invoked, 0);
      assert.ok(result.error);
      assert.equal(result.results.length, 0);
      assert.ok(readFileSync(path.join(home, 'evidence/report.json'), 'utf8').includes('error'));
    }
  });
});

test('rejects traversal, absolute paths, malformed names and more than six files', () => {
  withWorkspace(({ home, dir, add }) => {
    add('valid.json');
    assert.equal(discoverContracts(home, 'contracts').length, 1);
    for (const input of ['../credentials', '/tmp/contracts', '.', 'contracts/../foo',
                         'contracts//foo', 'https://server/path', 'C:/evil']) {
      assert.throws(() => discoverContracts(home, input));
    }
    add('bad[markdown].json');
    assert.throws(() => discoverContracts(home, 'contracts'));
    rmSync(path.join(dir, 'bad[markdown].json'));
    for (let i = 0; i < 6; i++) add('plan' + i + '.json');
    assert.throws(() => discoverContracts(home, 'contracts'), /at most six/);
  });
});

test('oversized, malformed and unsupported-schema contracts never reach Docker', () => {
  withWorkspace(({ home, dir, add }) => {
    add('bad.json');
    const runWith = content => {
      writeFileSync(path.join(dir, 'bad.json'), content);
      let invoked = false;
      const result = runGate({
        workspace: home, directory: 'contracts',
        outputDirectory: path.join(home, 'evidence'),
        invokeContract: () => { invoked = true; return accept(); }
      });
      assert.equal(result.passed, false);
      assert.equal(invoked, false);
    };
    runWith('{broken');
    runWith(' '.repeat(49 * 1024));
    runWith(JSON.stringify({ schemaVersion: 2, name: 'oops', steps: [] }));
  });
});

test('symlinked contract and symlinked folder are refused', {
  skip: process.platform === 'win32'
}, () => {
  withWorkspace(({ home, dir, add }) => {
    add('regular.json');
    const pointer = path.join(dir, 'link.json');
    symlinkSync(path.join(dir, 'regular.json'), pointer, 'file');
    assert.throws(() => discoverContracts(home, 'contracts'), /symlinks/);
    rmSync(pointer);
    symlinkSync(dir, path.join(home, 'alias'), 'dir');
    assert.throws(() => discoverContracts(home, 'alias'), /symlinks/);
  });
});

test('action is pinned to source code, Node and artifact upload SHAs', () => {
  const body = readFileSync(new URL('../.github/actions/contract-gate/action.yml', import.meta.url), 'utf8');
  assert.match(body, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.match(body, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(body, /github\.action_path/);
  assert.match(body, /\.\.\/\.\.\/\.\.\/scripts\/contract_pr_gate\.mjs/);
  assert.doesNotMatch(body, /secrets\./);
  const workflow = readFileSync(
    new URL('../.github/workflows/contract-gate-selftest.yml', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /uses: \.\/.github\/actions\/contract-gate/);
});
