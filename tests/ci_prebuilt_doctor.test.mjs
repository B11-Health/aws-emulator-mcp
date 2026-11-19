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

test('prebuilt-only doctor refuses missing/stale images before Docker build or run; matched image uses cached run',
  {skip:process.platform==='win32'},()=>{
    const folder=mkdtempSync(path.join(tmpdir(),'aws-ci-prebuilt-doctor-with-spaces '));
    const docker=path.join(folder,'docker');
    const log=path.join(folder,'fake-docker-calls.jsonl');
    const fake=`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='context') console.log(JSON.stringify('unix:///tmp/verified-local-docker.sock'));
else if(args[0]==='info') console.log('25.0.16');
else if(args[0]==='image') {
  if(process.env.MOCK_DOCKER_MISSING==='1')process.exit(4);
  console.log(process.env.MOCK_DOCKER_LABEL||'<missing-label>');
} else if(args[0]==='build'||args[0]==='pull')process.exit(99);
else if(args[0]==='run') console.log(JSON.stringify({ready:true,
  account_verified:true,emulator_version:'synthetic-inert',checks:[]}));
else process.exit(88);
`;
    writeFileSync(docker,fake);chmodSync(docker,0o755);
    try {
      const invoke=({missing=false,label=''})=>{
        writeFileSync(log,'');
        const env={...process.env,PATH:folder+path.delimiter+process.env.PATH,
          MOCK_DOCKER_LOG:log,MOCK_DOCKER_LABEL:label,
          MOCK_DOCKER_MISSING:missing?'1':'0',
          AWS_EMULATOR_MCP_QA_REQUIRE_PREBUILT:'1'};
        delete env.DOCKER_HOST;
        delete env.DOCKER_CONTEXT;
        const outcome=spawnSync(process.execPath,[CLI,'doctor','--json'],{
          env,encoding:'utf8',timeout:15000});
        const calls=readFileSync(log,'utf8').split('\n').filter(Boolean)
          .map(line=>JSON.parse(line));
        return {outcome,calls};
      };
      for(const scenario of [
        {missing:true,label:''},
        {missing:false,label:'0'.repeat(64)},
        {missing:false,label:'<unverified>'},
      ]) {
        const {outcome,calls}=invoke(scenario);
        assert.equal(outcome.status,1,outcome.stderr);
        assert.equal(outcome.stdout,'','Failed prebuilt-only doctor must emit no JSON');
        assert.match(outcome.stderr,/DOCKER_SMOKE_PREBUILT_IMAGE_REQUIRED/);
        assert.doesNotMatch(outcome.stderr,/rebuilding local image/i);
        assert.deepEqual(calls.map(args=>args[0]),['context','info','image']);
        assert.equal(calls.some(args=>args.includes('build')||args.includes('run')||
          args.includes('pull')),false);
      }
      const {outcome,calls}=invoke({label:imageSourceDigest(ROOT)});
      assert.equal(outcome.status,0,outcome.stderr);
      assert.equal(outcome.stderr,'');
      assert.equal(JSON.parse(outcome.stdout).ready,true);
      assert.deepEqual(calls.map(args=>args[0]),['context','info','image','run']);
      const selected=calls[3];
      assert.equal(selected.includes('--pull'),true);
      assert.equal(selected[selected.indexOf('--pull')+1],'never');
      assert.equal(selected.includes('--network'),true);
      assert.equal(selected[selected.indexOf('--network')+1],'none');
      assert.equal(calls.some(args=>args.includes('build')||args.includes('pull')),false);
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
