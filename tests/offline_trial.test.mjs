import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runOfflineTrial, formatOfflineTrial } from '../scripts/offline_trial.mjs';
import { executeArchitecture } from '../scripts/architecture_studio.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root,'bin/aws-emulator-mcp.mjs');
function cli(...args) {
  return spawnSync(process.execPath,[bin,...args],{
    encoding:'utf8',timeout:14000,
    env:{...process.env,DOCKER_HOST:'tcp://198.51.100.1:2375'}
  });
}

test('offline trial checks seven authentic generated artifacts and removes temp workspace',()=>{
  const ws=mkdtempSync(path.join(tmpdir(),'mcp-trial-test-'));
  const report=runOfflineTrial({createWorkspace:()=>ws});
  assert.equal(report.passed,true);
  assert.equal(report.artifactCount,7);
  assert.equal(report.syntheticContractSteps,14);
  assert.equal(report.dockerUsed,false);
  assert.equal(report.cloudCallsMade,false);
  assert.equal(report.generatedFilesPreserved,false);
  assert.match(report.sourceSha256,/^[a-f0-9]{64}$/);
  assert.equal(existsSync(ws),false);
  assert.match(formatOfflineTrial(report),/NOT executed/);
  assert.doesNotMatch(JSON.stringify(report),/mcp-trial-test-|198\.51\.100/);
});

test('tampering with an output checksum aborts proof and cleans up',()=>{
  const ws=mkdtempSync(path.join(tmpdir(),'mcp-trial-bad-'));
  const generator=workspace=>{
    const built=executeArchitecture(['demo'],workspace);
    writeFileSync(path.join(workspace,'reports','architecture-studio','diagram.svg'),'tampered');
    return built;
  };
  assert.throws(()=>runOfflineTrial({createWorkspace:()=>ws,generate:generator}),/checksum mismatch/);
  assert.equal(existsSync(ws),false);
});

test('missing output fails closed and removes temporary files',()=>{
  const ws=mkdtempSync(path.join(tmpdir(),'mcp-trial-missing-'));
  const generator=workspace=>({report:{generatedFiles:[],validated:{manifest:true}},json:false});
  assert.throws(()=>runOfflineTrial({createWorkspace:()=>ws,generate:generator}),/Unexpected/);
  assert.equal(existsSync(ws),false);
});

test('an invalid AWS deployment claim cannot become an offline success',()=>{
  const ws=mkdtempSync(path.join(tmpdir(),'mcp-trial-invalid-'));
  const generator=workspace=>{
    const built=executeArchitecture(['demo'],workspace);
    built.report.validated.awsDeployment=true;
    return built;
  };
  assert.throws(()=>runOfflineTrial({createWorkspace:()=>ws,generate:generator}),/Unexpected/);
  assert.equal(existsSync(ws),false);
});

test('CLI succeeds without Docker even if DOCKER_HOST points at remote daemon',()=>{
  const outcome=cli('try','--json');
  assert.equal(outcome.status,0,outcome.stderr);
  assert.equal(outcome.stderr,'');
  const proof=JSON.parse(outcome.stdout);
  assert.equal(proof.passed,true);
  assert.equal(proof.test,'offline-architecture-generation');
  assert.deepEqual(proof.resourceTypes,[
    'AWS::DynamoDB::Table','AWS::S3::Bucket','AWS::SQS::Queue'
  ]);
  assert.doesNotMatch(outcome.stdout,/\/tmp\/|[A-Z]:\\\\|198\.51\.100|token|password/i);
});

test('CLI rejects unknown flags and positional input before any work',()=>{
  for (const args of [['try','--unsafe'],['try','--json','--json'],
    ['try','https://example.com'],['try','file:///etc/passwd']]) {
    const result=cli(...args);
    assert.equal(result.status,2,result.stderr);
    assert.equal(result.stdout,'');
    assert.match(result.stderr,/Usage: aws-emulator-mcp try/);
  }
});
