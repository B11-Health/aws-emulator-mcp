import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inspectPreflight, printPreflight } from '../scripts/preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin/aws-emulator-mcp.mjs');
const localContext = JSON.stringify('unix:///var/run/docker.sock') + '\n';
const socket = 'unix:///var/run/docker.sock';
function fakeRun({cli = true, context = localContext, info = '25.0.16\n', image = false} = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[0] === '--version') return {status: cli ? 0 : 1, stdout: 'Docker version 25.0.16'};
    if (args[0] === 'context') return {status: 0, stdout: context};
    if (args[0] === 'info') return {status: info === null ? 1 : 0, stdout: info ?? ''};
    if (args[0] === 'image') return {status: image ? 0 : 1, stdout: image ? 'sha256:123' : ''};
    throw Error('Unexpected process call');
  };
  return {run, calls};
}

test('ready local Docker is checked read-only, no builds or API calls', () => {
  const {run, calls} = fakeRun({image: true});
  const report = inspectPreflight({nodeVersion:'22.0.0', platform:'linux', dockerHost:'', run});
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.architectureReady, true);
  assert.equal(report.emulatorReady, true);
  assert.equal(report.imageCached, true);
  assert.equal(report.nextCommand, 'aws-emulator-mcp doctor');
  assert.equal(report.dockerVersion, '25.0.16');
  assert.deepEqual(calls.map(x=>x.split(' ')[0]), ['--version', 'context', 'info', 'image']);
  assert.ok(calls.every(x => !/build|run|pull|exec|login|secret/.test(x)));
  assert.doesNotMatch(JSON.stringify(report), /var\/run\/docker\.sock|password|token|account-id/i);
});

test('missing Docker still gives no-Docker architecture path, skips other probes', () => {
  const {run,calls} = fakeRun({cli:false});
  const report = inspectPreflight({nodeVersion:'20.0.0', dockerHost:'',run});
  assert.equal(report.emulatorReady,false);
  assert.equal(report.architectureReady,true);
  assert.match(report.checks.docker.reason,/Docker CLI unavailable/);
  assert.equal(report.nextCommand,'aws-emulator-mcp architecture demo');
  assert.equal(calls.length, 1);
  assert.match(printPreflight(report),/No container was launched or built/);
});

test('remote DOCKER_HOST is blocked before any child process launches', () => {
  const {run,calls} = fakeRun({image:true});
  const report = inspectPreflight({nodeVersion:'22.0.0', dockerHost:'tcp://198.51.100.8:2375',run});
  assert.equal(report.emulatorReady,false);
  assert.equal(calls.length,0);
  assert.match(report.checks.docker.reason,/Nonlocal DOCKER_HOST refused/);
  assert.doesNotMatch(JSON.stringify(report),/198\.51\.100\.8/);
});

test('unverified/remote context rejects Docker info and image operations', () => {
  for (const context of ['invalid output', JSON.stringify('tcp://198.51.100.8:2375'), JSON.stringify(42)]) {
    const {run,calls} = fakeRun({context});
    const report = inspectPreflight({nodeVersion:'22.0.0',dockerHost:'',run});
    assert.equal(report.emulatorReady,false);
    assert.deepEqual(calls.map(x=>x.split(' ')[0]),['--version','context']);
    assert.match(report.checks.docker.reason,/context could not be verified/);
  }
});

test('local daemon stopped is a blocker without triggering image build', () => {
  const {run,calls} = fakeRun({info:null});
  const report = inspectPreflight({nodeVersion:'22.0.0', dockerHost:socket,run});
  assert.equal(report.emulatorReady,false);
  assert.equal(report.imageCached,null);
  assert.equal(calls.length,3);
  assert.match(report.checks.docker.reason,/daemon unavailable/);
});

test('uncached image requires a later build, not a failed preflight', () => {
  const {run} = fakeRun({image:false});
  const report = inspectPreflight({nodeVersion:'22.0.0', dockerHost:'', run});
  assert.equal(report.emulatorReady,true);
  assert.equal(report.imageCached,false);
  assert.equal(report.checks.image.passed,false);
  assert.match(report.checks.image.reason,/requires download/);
});

test('Node 18 cannot run this package even when Docker is available', () => {
  const {run} = fakeRun({image:true});
  const report = inspectPreflight({nodeVersion:'18.20.0', dockerHost:'', run});
  assert.equal(report.architectureReady,false);
  assert.equal(report.emulatorReady,false);
  assert.match(report.nextCommand,/Install Node\.js 20/);
});

test('CLI JSON is available without Docker and rejects options before probes', () => {
  const blocked = spawnSync(process.execPath,[bin,'preflight','--json'],{
    encoding:'utf8', timeout:12000, env:{...process.env,DOCKER_HOST:'tcp://198.51.100.8:2375'}
  });
  assert.equal(blocked.status,1);
  const report = JSON.parse(blocked.stdout);
  assert.equal(report.schemaVersion,1);
  assert.equal(report.emulatorReady,false);
  assert.match(report.checks.docker.reason,/Nonlocal/);
  assert.doesNotMatch(blocked.stdout,/198\.51\.100/);
  const invalid = spawnSync(process.execPath,[bin,'preflight','--execute'],{
    encoding:'utf8',timeout:12000
  });
  assert.equal(invalid.status,2);
  assert.equal(invalid.stdout,'');
  assert.match(invalid.stderr,/Usage: aws-emulator-mcp preflight/);
});
