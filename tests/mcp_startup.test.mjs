import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectMcpStartup} from '../scripts/mcp_startup.mjs';
import {imageSourceDigest} from '../scripts/image_identity.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BIN=path.join(ROOT,'bin/aws-emulator-mcp.mjs');
const ENDPOINT='unix:///tmp/verified Docker engine.sock';
const IMAGE='aws-emulator-mcp:0.4.0-beta.15';
const ID='sha256:'+'1'.repeat(64);
const RETAGGED='sha256:'+'2'.repeat(64);
const SHA='a'.repeat(64);
const LABEL='dev.aws-emulator-mcp.source-sha256';
const IMAGE_FORMAT=`{{.Id}}|{{index .Config.Labels "${LABEL}"}}`;

function fakeRead({context=ENDPOINT,info='linux',imageId=ID,label=SHA,
  imageStatus=0}={}) {
  const calls=[];
  function run(args,opts={}){
    calls.push({args,opts});
    if(args[0]==='context')return {status:0,stdout:JSON.stringify(context)};
    if(args[0]!=='--host'||args[1]!==ENDPOINT||opts.pinned!==true)
      throw Error('unsafe unpinned Docker inspection');
    if(args[2]==='info')return {status:0,stdout:info};
    if(args[2]==='image')return {status:imageStatus,stdout:`${imageId}|${label}`};
    throw Error('unexpected Docker operation');
  }
  return {run,calls};
}

test('source fingerprint and Docker host must be valid before any command',()=>{
  for(const digest of [undefined,'',SHA.toUpperCase(),'x'.repeat(64)]){
    const fixture=fakeRead();
    const result=inspectMcpStartup({expectedImageDigest:digest,run:fixture.run});
    assert.equal(result.ready,false);
    assert.equal(fixture.calls.length,0);
  }
  for(const remote of ['tcp://192.0.2.44:2375','ssh://remote.invalid',
     'npipe:////./pipe/\\\\remote.invalid', 'unix://../../unexpected']){
    const fixture=fakeRead();
    const result=inspectMcpStartup({expectedImageDigest:SHA,dockerHost:remote,run:fixture.run});
    assert.equal(result.ready,false);
    assert.equal(fixture.calls.length,0);
  }
});

test('read-only inspection binds the selected LOCAL Docker endpoint and image ID',()=>{
  const fixture=fakeRead();
  const report=inspectMcpStartup({expectedImageDigest:SHA,run:fixture.run});
  assert.deepEqual(report,{ready:true,endpoint:ENDPOINT,imageId:ID});
  assert.deepEqual(fixture.calls.map(x=>x.args),[
    ['context','inspect','--format','{{json .Endpoints.docker.Host}}'],
    ['--host',ENDPOINT,'info','--format','{{.OSType}}'],
    ['--host',ENDPOINT,'image','inspect',IMAGE,'--format',IMAGE_FORMAT]
  ]);
  assert.equal(fixture.calls.slice(1).every(c=>c.opts.pinned),true);
  assert.equal(fixture.calls.some(c=>c.args.includes('run')||c.args.includes('build')),false);
});

test('Windows Docker named pipe is supported only as a pinned local endpoint',()=>{
  const endpoint='npipe:////./pipe/docker_engine';
  const calls=[];
  const run=(args,opts={})=>{
    calls.push({args,opts});
    if(args[0]==='context')return {status:0,stdout:JSON.stringify(endpoint)};
    assert.equal(args[0],'--host');
    assert.equal(args[1],endpoint);
    assert.equal(opts.pinned,true);
    if(args[2]==='info')return {status:0,stdout:'linux'};
    if(args[2]==='image')return {status:0,stdout:ID+'|'+SHA};
    throw Error('unexpected command');
  };
  const outcome=inspectMcpStartup({expectedImageDigest:SHA,dockerHost:endpoint,run});
  assert.deepEqual(outcome,{ready:true,endpoint,imageId:ID});
  assert.deepEqual(calls.map(x=>x.args[0]==='--host'?x.args[2]:x.args[0]),
    ['context','info','image']);
  assert.equal(calls.some(x=>x.args.includes('run')||x.args.includes('build')),false);
});

test('remote context, conflicting host, wrong OS, invalid label and missing ID fail closed',()=>{
  const variants=[
    [{context:'tcp://192.0.2.4:2375'},undefined],
    [{context:'ssh://remote.invalid'},undefined],
    [{},'unix:///tmp/different-docker.sock'],
    [{info:'windows'},undefined],
    [{info:'unexpected'},undefined],
    [{imageStatus:1},undefined],
    [{imageId:'sha256:unverified'},undefined],
    [{label:'<no value>'},undefined],
    [{label:'f'.repeat(64)},undefined],
  ];
  for(const [opts,dockerHost] of variants){
    const fixture=fakeRead(opts);
    const result=inspectMcpStartup({expectedImageDigest:SHA,
      ...(dockerHost?{dockerHost}:{}),run:fixture.run});
    assert.equal(result.ready,false,JSON.stringify(opts));
    assert.equal(fixture.calls.some(x=>x.args.includes('run')||x.args.includes('build')),false);
    assert.equal(fixture.calls.slice(1).every(c=>c.args[0]==='--host'),true);
  }
});

// This fixture shadows the docker executable through PATH: absolutely no
// Docker daemon, images, container, AWS account, or network are used.
function withFakeDocker(fn){
  const folder=mkdtempSync(path.join(tmpdir(),'mcp pinned fake Docker '));
  const docker=path.join(folder,'docker');
  const log=path.join(folder,'calls.jsonl');
  const tagFile=path.join(folder,'tag-id');
  const contextFile=path.join(folder,'context-value');
  const stub=`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
const hasHost=args[0]==='--host';
const command=hasHost?args.slice(2):args;
const keys=Object.keys(process.env);
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify({args,
 awsLeaked:keys.some(k=>/^AWS_/i.test(k)),
 ambientContext:keys.some(k=>/^DOCKER_CONTEXT$/i.test(k)),
 ambientHost:keys.some(k=>/^DOCKER_HOST$/i.test(k)),
 ambientTls:keys.some(k=>/^DOCKER_(TLS_VERIFY|CERT_PATH)$/i.test(k))})+'\\n');
if(command[0]==='context'){
 console.log(JSON.stringify(process.env.MOCK_SELECTED_ENDPOINT));
}else if(command[0]==='info'){
 console.log(process.env.MOCK_OS||'linux');
}else if(command[0]==='image'){
 if(process.env.MOCK_IMAGE_MISSING==='1')process.exit(2);
 console.log(process.env.MOCK_INSPECT_ID+'|'+process.env.MOCK_IMAGE_LABEL);
 fs.writeFileSync(process.env.MOCK_TAG_STATE,process.env.MOCK_RETAGGED_ID);
 fs.writeFileSync(process.env.MOCK_CONTEXT_STATE,'tcp://198.51.100.77:2375');
}else if(command[0]==='run'){
 if(!hasHost||args[1]!==process.env.MOCK_SELECTED_ENDPOINT)process.exit(79);
 const immutable=command.at(-2);
 if(immutable!==process.env.MOCK_INSPECT_ID)process.exit(78);
 if(command.includes('--pull')&&command[command.indexOf('--pull')+1]==='never')
   console.log('SYNTHETIC_MCP_STDIO_ONLY');
 else process.exit(77);
}else if(command[0]==='build'||command[0]==='pull')process.exit(89);
else process.exit(91);
`;
  writeFileSync(docker,stub);chmodSync(docker,0o755);
  try{
    const invoke=(overrides={})=>{
      writeFileSync(log,'');writeFileSync(tagFile,ID);
      writeFileSync(contextFile,ENDPOINT);
      const env={...process.env,PATH:folder+path.delimiter+process.env.PATH,
        MOCK_LOG:log,MOCK_TAG_STATE:tagFile,MOCK_CONTEXT_STATE:contextFile,
        MOCK_SELECTED_ENDPOINT:ENDPOINT,
        MOCK_INSPECT_ID:ID,MOCK_RETAGGED_ID:RETAGGED,
        MOCK_IMAGE_LABEL:imageSourceDigest(ROOT),
        AWS_SECRET_ACCESS_KEY:'FAKE_TEST_VALUE_NO_AWS',
        AWS_ACCESS_KEY_ID:'FAKE_TEST_ACCESS_KEY',
        DOCKER_CONTEXT:'synthetic-selected-local-context',
        ...overrides};
      delete env.DOCKER_HOST;
      if(Object.hasOwn(overrides,'DOCKER_HOST'))env.DOCKER_HOST=overrides.DOCKER_HOST;
      const result=spawnSync(process.execPath,[BIN,'mcp'],{
        env,encoding:'utf8',timeout:16000});
      const commands=readFileSync(log,'utf8').split('\n').filter(Boolean)
        .map(line=>JSON.parse(line));
      return {result,commands,tagNow:readFileSync(tagFile,'utf8'),
        contextNow:readFileSync(contextFile,'utf8')};
    };
    return fn(invoke);
  }finally{rmSync(folder,{recursive:true,force:true});}
}

test('fake Docker retags an image and changes default context after inspect; MCP still starts immutable ID',
  {skip:process.platform==='win32'},()=>withFakeDocker(invoke=>{
    const {result,commands,tagNow,contextNow}=invoke();
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),'SYNTHETIC_MCP_STDIO_ONLY');
    assert.equal(result.stderr,'');
    assert.equal(tagNow,RETAGGED);
    assert.equal(contextNow,'tcp://198.51.100.77:2375');
    assert.deepEqual(commands.map(c=>c.args[0]==='--host'?c.args[2]:c.args[0]),
      ['context','info','image','run']);
    const checked=commands[2].args;
    const running=commands[3].args;
    assert.equal(checked[1],ENDPOINT);
    assert.equal(running[1],ENDPOINT);
    assert.equal(running.at(-2),ID);
    assert.notEqual(running.at(-2),IMAGE);
    assert.deepEqual(running.slice(2,9),
      ['run','--rm','-i','--pull','never','--network','none']);
    assert.equal(running.includes('-v')||running.includes('--mount'),false);
    assert.equal(commands.every(c=>c.awsLeaked===false),true);
    assert.equal(commands.slice(1).every(c=>c.ambientContext===false&&c.ambientHost===false),true);
    assert.equal(commands.some(c=>c.args.includes('build')||c.args.includes('pull')),false);
  }));

test('fake Docker pinned inspection and run scrub mixed-case credential and redirect aliases',
  {skip:process.platform==='win32'},()=>withFakeDocker(invoke=>{
    const {result,commands}=invoke({
      aws_secret_access_key:'SYNTHETIC_LOWERCASE_SECRET',
      Aws_Profile:'synthetic-profile',
      docker_context:'synthetic-lowercase-remote-context',
      Docker_Tls_Verify:'1',
      docker_cert_path:'/tmp/fake-certificate',
    });
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),'SYNTHETIC_MCP_STDIO_ONLY');
    assert.equal(commands.length,4);
    for(const item of commands){
      assert.equal(item.awsLeaked,false,'no casing of AWS_ may reach Docker CLI');
    }
    for(const item of commands.slice(1)){
      assert.equal(item.ambientHost,false);
      assert.equal(item.ambientContext,false);
      assert.equal(item.ambientTls,false);
      assert.equal(item.args[0],'--host');
      assert.equal(item.args[1],ENDPOINT);
    }
    assert.doesNotMatch(result.stdout+result.stderr,
      /SYNTHETIC_LOWERCASE_SECRET|synthetic-profile|fake-certificate/);
  }));

test('fake Docker: invalid source label, missing image and remote contexts never run/build/pull',
  {skip:process.platform==='win32'},()=>withFakeDocker(invoke=>{
    for(const overrides of [
      {MOCK_IMAGE_LABEL:'0'.repeat(64)},
      {MOCK_IMAGE_LABEL:'<no value>'},
      {MOCK_INSPECT_ID:'sha256:INVALID'},
      {MOCK_IMAGE_MISSING:'1'},
      {MOCK_OS:'windows'},
      {MOCK_SELECTED_ENDPOINT:'ssh://remote.invalid'},
      {DOCKER_HOST:'tcp://192.0.2.7:2375'},
      {DOCKER_HOST:'unix:///tmp/different-local-socket'},
    ]){
      const {result,commands}=invoke(overrides);
      assert.equal(result.status,1,JSON.stringify(overrides)+result.stderr);
      assert.equal(result.stdout,'');
      assert.match(result.stderr,/no image build was attempted/);
      assert.equal(commands.some(c=>c.args.includes('run')||c.args.includes('build')||
        c.args.includes('pull')),false,JSON.stringify(overrides));
      if(overrides.DOCKER_HOST?.startsWith('tcp://'))assert.equal(commands.length,0);
      assert.doesNotMatch(result.stderr,/ssh:\/\/remote\.invalid|192\.0\.2\.7/);
    }
  }));

test('README distinguishes R4 pinned MCP desktop startup from R3/beta and from GUI proof',()=>{
  const text=readFileSync(path.join(ROOT,'README.md'),'utf8');
  assert.match(text,/round-four branch/i);
  assert.match(text,/immutable image ID/);
  assert.match(text,/local Docker daemon endpoint/);
  assert.match(text,/\-\-pull never/);
  assert.match(text,/Earlier beta\.15 and round-three builds can still auto-build/);
  assert.doesNotMatch(text,/mcp launcher can build on client startup if not prepared/);
  assert.match(text,/not proof.*GUI/i);
});
