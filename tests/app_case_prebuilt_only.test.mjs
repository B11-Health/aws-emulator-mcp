import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,existsSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(root,'bin/aws-emulator-mcp.mjs');
const fixture=path.join(root,'examples/external-app-pilot');
const before=path.join(fixture,'before/receipt_handler.py');
const after=path.join(fixture,'after/receipt_handler.py');
const caseFile=path.join(fixture,'receipt-case.json');
const env={...process.env,DOCKER_HOST:'tcp://192.0.2.55:2375'};
delete env.AWS_EMULATOR_MCP_QA_REQUIRE_PREBUILT;
function invoke(parts,overrides={}) {
 return spawnSync(process.execPath,[cli,...parts],{
  encoding:'utf8',timeout:12000,env:{...env,...overrides}
 });
}

test('prebuilt-only rejects duplicate and unknown flags before contacting Docker',()=>{
 for(const parts of [
  ['app-case',after,caseFile,'--prebuilt-only','--prebuilt-only'],
  ['app-case-compare',before,after,caseFile,'--json','--json','--prebuilt-only'],
  ['app-case-compare',before,after,caseFile,'--unexpected'],
  ['app-case',after,caseFile,'--markdown','--prebuilt-only'],
 ]){
  const result=invoke(parts);
  assert.equal(result.status,2,result.stderr);
  assert.match(result.stderr,/Usage: aws-emulator-mcp app-case/);
  assert.equal(result.stdout,'');
  assert.doesNotMatch(result.stderr,/Refusing nonlocal DOCKER_HOST/);
 }
});

test('prebuilt-only never bypasses local daemon fence',()=>{
 for(const parts of [
  ['app-case',after,caseFile,'--json','--prebuilt-only'],
  ['app-case-compare',before,after,caseFile,'--json','--prebuilt-only'],
 ]){
  const result=invoke(parts);
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stderr,/Refusing nonlocal DOCKER_HOST/);
  assert.equal(result.stdout,'');
 }
});

test('prebuilt-only refuses source-mismatched local image without implicit build',
 {skip:process.platform==='win32'},()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'aws-mcp-prebuilt-only '));
  const bin=path.join(dir,'fake docker bin');
  mkdirSync(bin);
  const docker=path.join(bin,'docker');
  const marker=path.join(dir,'build-or-run-was-attempted');
  const script=`#!/bin/sh
case "$1" in
  context) printf '"unix:///var/run/docker.sock"\\n'; exit 0;;
  info) printf '28.0.0\\n'; exit 0;;
  image) printf 'stale-source-digest\\n'; exit 0;;
  *) printf 'unexpected' > "$PREBUILT_TEST_MARKER"; exit 91;;
esac
`;
  writeFileSync(docker,script);chmodSync(docker,0o755);
  try {
   for(const parts of [
    ['app-case',after,caseFile,'--prebuilt-only','--json'],
    ['app-case-compare',before,after,caseFile,'--prebuilt-only','--json']
   ]){
    const result=invoke(parts,{
     PATH:bin+path.delimiter+process.env.PATH,
     DOCKER_HOST:'',
     PREBUILT_TEST_MARKER:marker
    });
    assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,/Prebuilt image required: local signed emulator image is missing or source-mismatched/);
    assert.doesNotMatch(result.stderr,/rebuilding local image|building a local image|DOCKER_SMOKE_PREBUILT_IMAGE_REQUIRED/);
    assert.equal(result.stdout,'');
    assert.equal(existsSync(marker),false,'No Docker build or run may be attempted');
   }
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
