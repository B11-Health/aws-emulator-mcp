import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inspectPreflight, inspectWorkspaceDisk, printPreflight } from '../scripts/preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin/aws-emulator-mcp.mjs');
const localContext = JSON.stringify('unix:///var/run/docker.sock') + '\n';
const socket = 'unix:///var/run/docker.sock';
function fakeRun({cli = true, context = localContext, info = 'linux|25.0.16\n', image = false, label = 'a'.repeat(64), dockerRoot = '/var/lib/docker'} = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[0] === '--version') return {status: cli ? 0 : 1, stdout: 'Docker version 25.0.16'};
    if (args[0] === 'context') return {status: 0, stdout: context};
    if (args[0] === 'info') return args.at(-1) === '{{.DockerRootDir}}'
      ? {status:dockerRoot === null?1:0,stdout:dockerRoot??''}
      : {status: info === null ? 1 : 0, stdout: info ?? ''};
    if (args[0] === 'image') {
      if (args.at(-1).includes('Config.Labels')) return {status: label === null ? 1 : 0, stdout: label ?? ''};
      return {status: image ? 0 : 1, stdout: image ? 'sha256:123' : ''};
    }
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
  assert.equal(report.sourceCheckoutCommand, 'node bin/aws-emulator-mcp.mjs doctor');
  assert.equal(report.dockerVersion, '25.0.16');
  assert.deepEqual(calls.map(x=>x.split(' ')[0]), ['--version', 'context', 'info', 'info', 'image']);
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
  assert.equal(report.sourceCheckoutCommand,'node bin/aws-emulator-mcp.mjs architecture demo');
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

test('running Windows-container engine is rejected before image probe', () => {
  const {run,calls} = fakeRun({info:'windows|25.0.16\n',image:true});
  const report = inspectPreflight({nodeVersion:'22.0.0',platform:'win32',dockerHost:'',run});
  assert.equal(report.emulatorReady,false);
  assert.equal(report.imageCached,null);
  assert.match(report.checks.docker.reason,/Linux containers required/);
  assert.equal(calls.length,3);
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
  assert.match(report.limitations,/Cached image reuse requires a matching source fingerprint/);
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


test('host working-volume space is advisory and never claims Docker Desktop VM capacity', () => {
  const statfsLow = () => ({bsize:1024n,bavail:9n * 1024n * 1024n});
  const sample = inspectWorkspaceDisk(statfsLow);
  assert.equal(sample.freeGiB,9);
  assert.equal(sample.lowSpaceAdvisory,true);
  assert.equal(sample.dockerDataCapacityVerified,false);
  const {run,calls} = fakeRun({image:true});
  const report = inspectPreflight({nodeVersion:'22.0.0',platform:'win32',dockerHost:'',run,statfs:statfsLow});
  assert.equal(report.emulatorReady,true);
  assert.equal(report.hostWorkspaceDisk.lowSpaceAdvisory,true);
  assert.match(printPreflight(report),/below 10 GiB on host working volume/);
  assert.match(printPreflight(report),/Docker storage NOT verified/);
  assert.deepEqual(calls.map(x=>x.split(' ')[0]),['--version','context','info','image']);
});

test('host disk probe failure is nonfatal, read-only, and never exposes a local path', () => {
  const unknown = inspectWorkspaceDisk(() => { throw Error('SECRET_PRIVATE_HOME_PATH'); });
  assert.equal(unknown.freeGiB,null);
  assert.equal(unknown.lowSpaceAdvisory,null);
  assert.equal(unknown.dockerDataCapacityVerified,false);
  assert.doesNotMatch(JSON.stringify(unknown),/SECRET_PRIVATE_HOME_PATH/);
  for(const bad of [
    {bsize:0n,bavail:123n}, {bsize:512n,bavail:-1n},
    {bsize:123456789123456789n,bavail:123456789123456789n}
  ])assert.equal(inspectWorkspaceDisk(()=>bad).freeGiB,null);
  const {run} = fakeRun({cli:false});
  const r=inspectPreflight({run,statfs:()=>{throw Error('SECRET_PRIVATE_HOME_PATH')}});
  assert.equal(r.emulatorReady,false);
  assert.doesNotMatch(JSON.stringify(r),/SECRET_PRIVATE_HOME_PATH/);
});

test('valid cached image source fingerprint makes preflight explicitly report reuse', () => {
  const hash = 'a'.repeat(64);
  const {run,calls} = fakeRun({image:true,label:hash});
  const report=inspectPreflight({nodeVersion:'22.0.0',dockerHost:'',run,
    expectedImageDigest:()=>hash,statfs:()=>({bsize:4096n,bavail:3n*1024n*1024n})});
  assert.equal(report.imageCached,true);
  assert.equal(report.imageReusable,true);
  assert.equal(report.imageSourceStatus,'matched');
  assert.equal(report.emulatorReady,true);
  assert.match(printPreflight(report),/matches current checkout/);
  assert.equal(calls.filter(x=>x.startsWith('image inspect')).length,2);
  assert.doesNotMatch(JSON.stringify(report),new RegExp(hash));
});

test('stale cached tag is not treated as reusable and next command rebuilds it', () => {
  const {run,calls} = fakeRun({image:true,label:'b'.repeat(64)});
  const report=inspectPreflight({nodeVersion:'22.0.0',dockerHost:'',run,
    expectedImageDigest:()=> 'a'.repeat(64)});
  assert.equal(report.imageCached,true);
  assert.equal(report.imageReusable,false);
  assert.equal(report.imageSourceStatus,'mismatched');
  assert.equal(report.checks.image.passed,false);
  assert.match(report.checks.image.reason,/will rebuild/);
  assert.match(printPreflight(report),/rebuild needed/);
  assert.equal(report.emulatorReady,true);
  assert.ok(calls.every(x=>!/^build|^pull|^run|^exec/.test(x)));
});

test('unverified image label or unreadable local digest never authorizes reuse', () => {
  for(const label of [null,'<no value>','zzzzzzzz']) {
    const {run}=fakeRun({image:true,label});
    const report=inspectPreflight({nodeVersion:'22.0.0',dockerHost:'',run,
      expectedImageDigest:()=> 'a'.repeat(64)});
    assert.equal(report.imageReusable,false);
    assert.equal(report.imageSourceStatus,'unverified');
    assert.equal(report.checks.image.passed,false);
  }
  const {run}=fakeRun({image:true});
  const report=inspectPreflight({nodeVersion:'22.0.0',dockerHost:'',run,
    expectedImageDigest:()=>{throw Error('PRIVATE_PATH')}});
  assert.equal(report.imageSourceStatus,'unverified');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_PATH/);
});

test('remote Docker host refuses before any Docker call or cache fingerprint evaluation', () => {
  const {run,calls}=fakeRun({image:true});
  let sourceReads=0;
  const r=inspectPreflight({nodeVersion:'22.0.0',dockerHost:'ssh://forbidden.example',run,
    expectedImageDigest:()=>{sourceReads++;return 'a'.repeat(64)}});
  assert.equal(r.emulatorReady,false);
  assert.equal(r.imageSourceStatus,'not-checked');
  assert.equal(sourceReads,0);
  assert.equal(calls.length,0);
});


test('Linux preflight distinguishes /tmp workspace from host-visible Docker data-root volume', () => {
  const {run,calls}=fakeRun({image:false,dockerRoot:'/var/lib/docker'});
  const statfs=directory=>directory==='/var/lib/docker'
    ? {bsize:1024n,bavail:7n*1024n*1024n}
    : {bsize:1024n,bavail:12n*1024n*1024n};
  const r=inspectPreflight({nodeVersion:'22.0.0',platform:'linux',dockerHost:'',run,statfs});
  assert.equal(r.emulatorReady,true);
  assert.equal(r.hostWorkspaceDisk.freeGiB,12);
  assert.equal(r.hostWorkspaceDisk.lowSpaceAdvisory,false);
  assert.equal(r.hostVisibleDockerRootDisk.freeGiB,7);
  assert.equal(r.hostVisibleDockerRootDisk.lowSpaceAdvisory,true);
  assert.equal(r.hostVisibleDockerRootDisk.dockerDaemonNamespaceVerified,false);
  assert.match(printPreflight(r),/host-visible Docker data root below 10 GiB/);
  assert.doesNotMatch(JSON.stringify(r),/var\/lib\/docker/);
  assert.ok(calls.includes('info --format {{.DockerRootDir}}'));
  assert.ok(!calls.some(x=>/^build|^pull|^run|^exec/.test(x)));
});

test('host-visible Docker data-root probe degrades safely when daemon root is inaccessible', () => {
  const {run}=fakeRun({image:true,dockerRoot:'/var/lib/docker'});
  const r=inspectPreflight({nodeVersion:'22.0.0',platform:'linux',dockerHost:'',run,
    statfs:directory=>{if(directory==='/var/lib/docker')throw Error('PRIVATE_DOCKER_PATH');return {bsize:1024n,bavail:11n*1024n*1024n};}});
  assert.equal(r.emulatorReady,true);
  assert.equal(r.hostVisibleDockerRootDisk.freeGiB,null);
  assert.match(printPreflight(r),/data-root volume space: unavailable/);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE_DOCKER_PATH|var\/lib\/docker/);
  const {run:windowsRun,calls}=fakeRun({image:false});
  const w=inspectPreflight({nodeVersion:'22.0.0',platform:'win32',dockerHost:'',run:windowsRun});
  assert.equal(w.hostVisibleDockerRootDisk,null);
  assert.equal(calls.filter(x=>x.includes('DockerRootDir')).length,0);
});

test('unsafe daemon root output is not opened or exposed', () => {
  for(const dockerRoot of ['/var/lib/../secrets','relative/path','/var/lib/docker\nPRIVATE_PATH',null]) {
    const {run}=fakeRun({image:false,dockerRoot});
    let probed=false;
    const r=inspectPreflight({nodeVersion:'22.0.0',platform:'linux',dockerHost:'',run,
      statfs:()=>{probed=true;return {bsize:1024n,bavail:1024n*1024n};}});
    assert.equal(r.hostVisibleDockerRootDisk,null);
    assert.doesNotMatch(JSON.stringify(r),/PRIVATE_PATH|secrets/);
    assert.equal(probed,true); // The unrelated host-working-volume probe still ran.
  }
});
