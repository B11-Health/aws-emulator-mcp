/** Inert subprocess process-tree QA. Every docker invocation uses a fake
 * executable in a private PATH; NO actual Docker or AWS commands execute. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'bin/aws-emulator-mcp.mjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function fakeWorkspace(){
  const folder=mkdtempSync(path.join(tmpdir(),'aws-inert-build-tree-with-spaces '));
  const pidFile=path.join(folder,'build.pid');
  const descendantFile=path.join(folder,'descendant.pid');
  const descendantScript=path.join(folder,'descendant.js');
  writeFileSync(descendantScript, `
    const fs=require('node:fs');
    process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{});
    fs.writeFileSync(process.env.MOCK_DESCENDANT_PID,String(process.pid));
    setInterval(()=>{},1000);
  `);
  const fake=path.join(folder,'docker');
  writeFileSync(fake,`#!/usr/bin/env node
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const args=process.argv.slice(2);
if(args[0]==='--version')console.log('Docker version 25.0.0');
else if(args[0]==='context')console.log(JSON.stringify('unix:///tmp/inert-local.sock'));
else if(args[0]==='info') {
  if(args.some(x=>x.includes('OSType')))console.log('linux|25.0.0');
  else if(args.some(x=>x.includes('ServerVersion')))console.log('25.0.0');
  else console.log('/var/lib/inert-only');
} else if(args[0]==='image')process.exit(4);
else if(args[0]==='build') {
  fs.writeFileSync(process.env.MOCK_BUILD_PID,String(process.pid));
  console.log('INERT_VISIBLE_BUILD_DIAGNOSTIC');
  if(process.env.MOCK_BUILD_MODE==='exit17')process.exit(17);
  const grandchild=spawn(process.execPath,[process.env.MOCK_DESCENDANT_SCRIPT],{
    stdio:['ignore','inherit','inherit'],env:process.env,shell:false
  });
  if(!grandchild.pid)process.exit(61);
  process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{});
  setInterval(()=>{},1000);
} else process.exit(88);
`);
  chmodSync(fake,0o755);
  const env={...process.env,PATH:folder+path.delimiter+process.env.PATH,
    MOCK_BUILD_PID:pidFile,MOCK_DESCENDANT_PID:descendantFile,
    MOCK_DESCENDANT_SCRIPT:descendantScript};
  delete env.AWS_EMULATOR_MCP_QA_REQUIRE_PREBUILT;
  delete env.DOCKER_HOST;
  delete env.DOCKER_CONTEXT;
  return {folder,fake,pidFile,descendantFile,env};
}

function running(pid){
  if(!Number.isInteger(pid)||pid<=0)return false;
  try {process.kill(pid,0);}catch{return false;}
  // Linux may retain a reaped child's zombie briefly; a zombie isn't running.
  try {const status=readFileSync(`/proc/${pid}/stat`,'utf8');
    if(/\) Z /.test(status))return false;
  }catch{}
  return true;
}

async function until(condition,ms=7000){
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){if(condition())return;await delay(35);}
  throw Error('Inert child did not reach expected state before deadline');
}

function tracked(proc){
  let stdout='',stderr='';
  proc.stdout.on('data',b=>{stdout+=b.toString('utf8');});
  proc.stderr.on('data',b=>{stderr+=b.toString('utf8');});
  const closed=new Promise((resolve,reject)=>{
    proc.once('error',reject);
    proc.once('close',(code,signal)=>resolve({code,signal}));
  });
  return {closed,output:()=>({stdout,stderr})};
}

for(const [signal,exitCode] of [['SIGTERM',143],['SIGINT',130]]){
  test(`explicit signed build ${signal} reaps its inert Docker parent and stubborn grandchild`,
    {skip:process.platform==='win32',timeout:16000},async()=>{
      const mock=fakeWorkspace();
      // A private PATH contains our fake executable, not the Docker CLI.
      assert.equal(existsSync(mock.fake),true);
      const proc=spawn(process.execPath,[CLI,'build'],{
        cwd:ROOT,env:mock.env,stdio:['ignore','pipe','pipe'],shell:false
      });
      const view=tracked(proc);
      let buildPid=null,descendantPid=null;
      try{
        await until(()=>existsSync(mock.pidFile)&&existsSync(mock.descendantFile));
        buildPid=Number(readFileSync(mock.pidFile,'utf8'));
        descendantPid=Number(readFileSync(mock.descendantFile,'utf8'));
        assert.equal(running(buildPid),true);
        assert.equal(running(descendantPid),true);
        assert.equal(proc.kill(signal),true);
        const {code,signal:exitSignal}=await view.closed;
        assert.equal(exitSignal,null);
        assert.equal(code,exitCode);
        await until(()=>!running(buildPid)&&!running(descendantPid),3000);
        const {stdout,stderr}=view.output();
        assert.equal(stdout,'');
        assert.match(stderr,/INERT_VISIBLE_BUILD_DIAGNOSTIC/);
        assert.match(stderr,/build interrupted/);
        assert.doesNotMatch(stderr,/FAKE_CREDENTIAL_VALUE_DO_NOT_ECHO/);
      }finally{
        // Never leave test children alive even if a regression occurs.
        if(Number.isInteger(buildPid)&&buildPid>0){
          try{process.kill(-buildPid,'SIGKILL');}catch{}
        }
        if(Number.isInteger(descendantPid)&&descendantPid>0){
          try{process.kill(descendantPid,'SIGKILL');}catch{}
        }
        if(running(proc.pid))proc.kill('SIGKILL');
        rmSync(mock.folder,{recursive:true,force:true});
      }
    });
}

test('explicit build failure preserves fake Docker diagnostics on stderr and controlled status',
  {skip:process.platform==='win32',timeout:12000},()=>{
    const mock=fakeWorkspace();
    try{
      const outcome=spawnSync(process.execPath,[CLI,'build'],{
        cwd:ROOT,env:{...mock.env,MOCK_BUILD_MODE:'exit17'},encoding:'utf8',
        timeout:9000,shell:false
      });
      assert.equal(outcome.status,17,outcome.stderr);
      assert.equal(outcome.stdout,'');
      assert.match(outcome.stderr,/INERT_VISIBLE_BUILD_DIAGNOSTIC/);
      assert.match(outcome.stderr,/Image build failed/);
    }finally{rmSync(mock.folder,{recursive:true,force:true});}
  });
