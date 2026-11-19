import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {imageSourceDigest} from '../scripts/image_identity.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'bin/aws-emulator-mcp.mjs');

function withFakeDocker(fn){
  const folder=mkdtempSync(path.join(tmpdir(),'CI coverage prebuilt-only fake docker '));
  const fake=path.join(folder,'docker');
  const callsFile=path.join(folder,'calls.jsonl');
  const script=`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CI_DOCKER_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='context')console.log(JSON.stringify('unix:///var/run/docker.sock'));
else if(args[0]==='info')console.log('25.0.16');
else if(args[0]==='--version')console.log('Docker version 25.0.16');
else if(args[0]==='image'){
  if(process.env.FAKE_CI_IMAGE_MISSING==='1')process.exit(2);
  console.log(process.env.FAKE_CI_IMAGE_LABEL||'<missing>');
}else if(args[0]==='run'){
  console.log(JSON.stringify({modeledServiceCount:425,totalProbes:20,
    successfulProbes:20,results:[],source:'inert fake'}));
}else if(args[0]==='build')console.log('INERT_SIGNED_IMAGE_BUILD_STUB');
else if(args[0]==='pull')process.exit(98);
else process.exit(99);
`;
  writeFileSync(fake,script);chmodSync(fake,0o755);
  try{
    const invoke=(command,{label='',missing=false,prebuiltOnly=true}={})=>{
      writeFileSync(callsFile,'');
      const env={...process.env,
        PATH:folder+path.delimiter+process.env.PATH,
        FAKE_CI_DOCKER_LOG:callsFile,
        FAKE_CI_IMAGE_MISSING:missing?'1':'0',
        FAKE_CI_IMAGE_LABEL:label};
      delete env.DOCKER_HOST;
      delete env.DOCKER_CONTEXT;
      delete env.AWS_EMULATOR_MCP_QA_REQUIRE_PREBUILT;
      if(prebuiltOnly)env.AWS_EMULATOR_MCP_QA_REQUIRE_PREBUILT='1';
      const argumentsForCommand=command==='build' ? [CLI,command] : [CLI,command,'--json'];
      const response=spawnSync(process.execPath,argumentsForCommand,{
        cwd:ROOT,env,encoding:'utf8',timeout:15000});
      const calls=readFileSync(callsFile,'utf8').split('\n').filter(Boolean)
        .map(line=>JSON.parse(line));
      return {response,calls};
    };
    fn(invoke);
  }finally{rmSync(folder,{recursive:true,force:true});}
}

test('prebuilt-only coverage refuses missing or stale image with no build/run or stdout',
 {skip:process.platform==='win32'},()=>withFakeDocker(invoke=>{
   const scenarios=[{missing:true},{label:'0'.repeat(64)},{label:'<invalid-source-label>'}];
   for(const scenario of scenarios){
     const {response,calls}=invoke('coverage',scenario);
     assert.equal(response.status,1,response.stderr);
     assert.equal(response.stdout,'');
     assert.match(response.stderr,/DOCKER_SMOKE_PREBUILT_IMAGE_REQUIRED/);
     assert.doesNotMatch(response.stderr,/rebuilding local image/i);
     assert.deepEqual(calls.map(args=>args[0]),['context','info','image']);
     assert.equal(calls.some(args=>['build','pull','run'].includes(args[0])),false);
   }
 }));

test('prebuilt-only coverage uses matching cached image without build/pull',
 {skip:process.platform==='win32'},()=>withFakeDocker(invoke=>{
   const {response,calls}=invoke('coverage',{label:imageSourceDigest(ROOT)});
   assert.equal(response.status,0,response.stderr);
   assert.equal(response.stderr,'');
   const report=JSON.parse(response.stdout);
   assert.equal(report.successfulProbes,20);
   assert.deepEqual(calls.map(args=>args[0]),['context','info','image','run']);
   assert.equal(calls[3].includes('--pull'),true);
   assert.equal(calls[3][calls[3].indexOf('--pull')+1],'never');
   assert.equal(calls[3].includes('--network'),true);
   assert.equal(calls[3][calls[3].indexOf('--network')+1],'none');
 }));

test('explicit build remains available outside smoke-only prebuilt environment',
 {skip:process.platform==='win32'},()=>withFakeDocker(invoke=>{
   const {response,calls}=invoke('build',{label:'0'.repeat(64),prebuiltOnly:false});
   assert.equal(response.status,0,response.stderr);
   assert.equal(response.stdout,'');
   assert.deepEqual(calls.filter(args=>args[0]==='build').length,1);
   assert.equal(calls.some(args=>args[0]==='run'),false);
   assert.equal(calls.some(args=>args[0]==='pull'),false);
   const actualBuild=calls.find(args=>args[0]==='build');
   assert.equal(actualBuild.includes('--pull'),true,
     'explicit signed build is still allowed to fetch its pinned upstream base');
   assert.equal(actualBuild.includes('--build-arg'),true);
 }));
