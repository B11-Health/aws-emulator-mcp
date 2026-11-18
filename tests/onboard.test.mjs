import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  parseOnboardArgs, runOnboarding, summarizeOnboarding, formatOnboarding
} from '../scripts/onboard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/aws-emulator-mcp.mjs');
const trial = {
  passed: true, test: 'offline-architecture-generation',
  artifactCount:7, syntheticContractSteps:14,
  resourceTypes:['AWS::S3::Bucket','AWS::DynamoDB::Table','AWS::SQS::Queue'],
  dockerUsed:false, cloudCallsMade:false, generatedFilesPreserved:false
};
const blocked = {
  checks:{node:{passed:true},docker:{passed:false,reason:'Docker CLI unavailable'}},
  emulatorReady:false,
  hostWorkspaceDisk:{lowSpaceAdvisory:false}
};
const ready = {
  checks:{node:{passed:true},docker:{passed:true},image:{passed:true}},
  emulatorReady:true, imageReusable:true,
  hostWorkspaceDisk:{lowSpaceAdvisory:false},
  hostVisibleDockerRootDisk:{lowSpaceAdvisory:false}
};

test('invalid or duplicated flags are rejected without starting a tool',()=>{
  assert.deepEqual(parseOnboardArgs(['--offline','--json']),{offline:true,json:true});
  assert.deepEqual(parseOnboardArgs([]),{offline:false,json:false});
  for(const args of [['--run'],['--json','--json'],['--offline','--offline'],
                     ['--force'],['--all'],['--json','--offline','--run']]) {
    assert.throws(()=>parseOnboardArgs(args),/Usage/);
  }
});

test('the first win is architecture evidence, never an AWS or app claim',()=>{
  const report=summarizeOnboarding({trial,preflight:blocked});
  assert.equal(report.status,'offline_first_win');
  assert.equal(report.passed,true);
  assert.equal(report.firstWin.artifactCount,7);
  assert.equal(report.firstWin.contractExecuted,false);
  assert.equal(report.readiness.emulator,'docker_blocked');
  assert.equal(report.readiness.dockerProbePerformed,true);
  assert.ok(report.nextSteps.some(x=>x.id==='docker-help'));
  assert.ok(report.nextSteps.some(x=>x.id==='inspect-own-app'));
  assert.ok(report.nextSteps.every(x=>x.automatic === false));
  assert.deepEqual(report.safety, {
    noDockerBuildOrRun:true,
    noApplicationSourceExecution:true,
    noCloudCalls:true,
    noProductionCredentialReads:true
  });
  assert.match(formatOnboarding(report),/NOT executed/);
  assert.match(formatOnboarding(report),/offline architecture still works/);
  assert.doesNotMatch(JSON.stringify(report),/AWS_PROFILE|AWS_SECRET_ACCESS_KEY/);
});

test('installed CLI receives executable commands without checkout-relative paths',()=>{
  const report=summarizeOnboarding({trial,preflight:ready,fromCheckout:false});
  assert.equal(report.commandContext,'installed-cli');
  assert.equal(report.nextSteps.find(x=>x.id==='test-aws-locally').command,
    'aws-emulator-mcp doctor');
  assert.equal(report.nextSteps.find(x=>x.id==='inspect-own-app').command,
    'aws-emulator-mcp app-case-inspect examples/app-case/fixed.py examples/app-case/sqs-idempotency.json --json');
  assert.ok(report.nextSteps.every(x=>!x.command.startsWith('node bin/')));
});

test('offline mode never probes Docker even when a probe would throw',()=>{
  let called=0;
  const report=runOnboarding({offlineOnly:true,trial:()=>trial,preflight:()=>{
    called++; throw Error('Docker may be unavailable');
  }});
  assert.equal(called,0);
  assert.equal(report.status,'offline_first_win');
  assert.equal(report.readiness.emulator,'not_checked');
  assert.equal(report.readiness.dockerProbePerformed,false);
  assert.ok(report.nextSteps.some(x=>x.id==='check-docker'));
  assert.doesNotMatch(formatOnboarding(report),/Docker: local Linux daemon prerequisites/);
});

test('a warm local image gives an explicit opt-in doctor, not a hidden launch',()=>{
  const report=summarizeOnboarding({trial,preflight:ready});
  assert.equal(report.readiness.emulator,'docker_ready_not_started');
  assert.equal(report.readiness.imageReusable,true);
  assert.equal(report.readiness.imageBuildRequiredBeforeDoctor,false);
  assert.equal(report.nextSteps.find(x=>x.id==='test-aws-locally').command,
    'node bin/aws-emulator-mcp.mjs doctor');
  assert.ok(report.nextSteps.every(x=>!x.automatic));
});

test('stale/missing Docker images and low storage recommend a build, never run one',()=>{
  const p={...ready,imageReusable:false,imageCached:true,
    checks:{...ready.checks,image:{passed:false,reason:'Cached image mismatch'}},
    hostVisibleDockerRootDisk:{lowSpaceAdvisory:true}};
  const report=summarizeOnboarding({trial,preflight:p});
  assert.equal(report.readiness.imageBuildRequiredBeforeDoctor,true);
  assert.equal(report.readiness.lowDiskAdvisory,true);
  assert.equal(report.nextSteps.find(x=>x.id==='test-aws-locally').command,
    'node bin/aws-emulator-mcp.mjs build');
  assert.match(formatOnboarding(report),/Disk advisory/);
  assert.match(formatOnboarding(report),/download\/build/);
});

test('invalid first-win evidence and exceptions fail closed and sanitize details',()=>{
  for (const bad of [
    {...trial,artifactCount:6},
    {...trial,cloudCallsMade:true},
    {...trial,generatedFilesPreserved:true},
    {...trial,passed:false},
  ]) {
    const result=summarizeOnboarding({trial:bad,preflight:ready});
    assert.equal(result.passed,false);
    assert.equal(result.firstWin.artifactCount,0);
    assert.equal(result.firstWin.contractExecuted,false);
    assert.equal(result.nextSteps[0].id, 'retry-offline');
    assert.ok(!result.nextSteps.some(x => x.id === 'test-aws-locally'));
  }
  const failed=runOnboarding({trial:()=>{
    throw Error('PRIVATE_WORKSPACE=/home/secret AWS_SECRET_ACCESS_KEY=SECRET');
  },preflight:()=>{throw Error('AWS_PROFILE=secret');}});
  assert.equal(failed.passed,false);
  assert.equal(failed.readiness.emulator,'docker_blocked');
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_WORKSPACE|SECRET|AWS_PROFILE/);
});

test('CLI offline success emits a bounded, parseable JSON report without Docker',()=>{
  const env={...process.env,PATH:'/nonexistent',
    DOCKER_HOST:'tcp://198.51.100.88:2376',
    AWS_SECRET_ACCESS_KEY:'NEVER_EXPOSE_THIS_VALUE'};
  const r=spawnSync(process.execPath,[BIN,'onboard','--offline','--json'],
    {encoding:'utf8',timeout:20000,env});
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stderr,'');
  const report=JSON.parse(r.stdout);
  assert.equal(report.status,'offline_first_win');
  assert.equal(report.readiness.dockerProbePerformed,false);
  assert.equal(report.firstWin.artifactCount,7);
  assert.equal(report.firstWin.contractExecuted,false);
  assert.doesNotMatch(r.stdout,/198\.51\.100\.88|NEVER_EXPOSE_THIS_VALUE/);
});

test('CLI launched from outside checkout returns installed-style follow-up commands',()=>{
  const env={...process.env,PATH:'/nonexistent'};
  const r=spawnSync(process.execPath,[BIN,'onboard','--offline','--json'],{
    encoding:'utf8',timeout:20000,env,cwd:path.dirname(ROOT)
  });
  assert.equal(r.status,0,r.stderr);
  const report=JSON.parse(r.stdout);
  assert.equal(report.commandContext,'installed-cli');
  assert.equal(report.nextSteps[0].command,'aws-emulator-mcp architecture demo');
});

test('first run stays successful and actionable when Docker is not installed',()=>{
  const env={...process.env,PATH:'/nonexistent',DOCKER_HOST:''};
  const r=spawnSync(process.execPath,[BIN,'onboard','--json'],{
    encoding:'utf8',timeout:20000,env
  });
  assert.equal(r.status,0,r.stderr);
  const report=JSON.parse(r.stdout);
  assert.equal(report.status,'offline_first_win');
  assert.equal(report.readiness.emulator,'docker_blocked');
  assert.match(report.readiness.reason,/Docker CLI unavailable/);
  assert.equal(report.readiness.dockerProbePerformed,true);
  assert.equal(report.safety.noDockerBuildOrRun,true);
  assert.ok(report.nextSteps.some(x=>x.id==='docker-help'));
  assert.doesNotMatch(r.stdout,/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
});

test('CLI declines remote Docker and still returns a valid offline first win',()=>{
  const env={...process.env,DOCKER_HOST:'tcp://198.51.100.88:2376'};
  const r=spawnSync(process.execPath,[BIN,'onboard','--json'],
    {encoding:'utf8',timeout:20000,env});
  assert.equal(r.status,0,r.stderr);
  const report=JSON.parse(r.stdout);
  assert.equal(report.status,'offline_first_win');
  assert.equal(report.readiness.emulator,'docker_blocked');
  assert.match(report.readiness.reason,/Nonlocal DOCKER_HOST refused/);
  assert.doesNotMatch(r.stdout,/198\.51\.100\.88/);
});

test('CLI usage errors exit 2 and print no JSON',()=>{
  for (const args of [['--run'],['--json','--json']]) {
    const r=spawnSync(process.execPath,[BIN,'onboard',...args],{
      encoding:'utf8',timeout:10000
    });
    assert.equal(r.status,2);
    assert.equal(r.stdout,'');
    assert.match(r.stderr,/Usage/);
  }
});
