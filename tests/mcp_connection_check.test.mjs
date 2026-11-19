import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  inspectMcpConnection, handshakeInput, formatMcpConnection, dockerChildEnv
} from '../scripts/mcp_connection_check.mjs';

const BIN=fileURLToPath(new URL('../bin/aws-emulator-mcp.mjs',import.meta.url));
const SOURCE='a'.repeat(64);
const IMAGE_ID='sha256:'+'b'.repeat(64);
const ENDPOINT='unix:///var/run/docker.sock';
const ready={
  emulatorReady:true,
  checks:{docker:{passed:true}},
  imageReusable:true,
  imageSourceStatus:'matched'
};
const reply=(id,result)=>JSON.stringify({jsonrpc:'2.0',id,result});
const status={installed:true,running:true,port:9297,
  endpoint:'https://127.0.0.1:9297',body:'ok'};
const successfulReplies=()=>[
  reply(1,{protocolVersion:'2025-11-25',serverInfo:{name:'aws-emulator-mcp'}}),
  reply(2,{tools:[{name:'emulator_status'},{name:'emulator_doctor'}]}),
  reply(3,{content:[{type:'text',text:JSON.stringify(status)}],isError:false})
].join('\n')+'\n';

function changedStatus(key,value) {
  const lines=successfulReplies().trim().split('\n');
  const response=JSON.parse(lines[2]);
  const body=JSON.parse(response.result.content[0].text);
  if(value===undefined) delete body[key];
  else body[key]=value;
  response.result.content[0].text=JSON.stringify(body);
  lines[2]=JSON.stringify(response);
  return lines.join('\n')+'\n';
}

/** All tests use a synthetic Docker command runner; no Docker run or AWS call. */
function mockDocker({endpoint=ENDPOINT,hostStatus=0,daemon='linux',
  imageEvidence=IMAGE_ID+'|'+SOURCE,replyBody=successfulReplies(),
  transportStatus=0}={}) {
  const calls=[];
  const run=(args,input,options={})=>{
    calls.push({args,input,options});
    if(args[0]==='context')
      return {status:hostStatus,stdout:JSON.stringify(endpoint)+'\n'};
    if(args[0]==='--host' && args[2]==='info')
      return {status:0,stdout:daemon+'\n'};
    if(args[0]==='--host' && args[2]==='image')
      return {status:0,stdout:imageEvidence+'\n'};
    if(args[0]==='--host' && args[2]==='run')
      return {status:transportStatus,stdout:replyBody};
    throw Error('Unexpected Docker command');
  };
  return {run,calls};
}
const handshakeCount=calls=>calls.filter(x=>x.args[2]==='run').length;

test('positive MCP check requires exact lowercase ok health body, revalidates daemon and runs immutable ID',()=>{
  const mock=mockDocker();
  const report=inspectMcpConnection({readiness:ready,expectedImageDigest:SOURCE,
    fromCheckout:true,run:mock.run});
  assert.equal(report.passed,true);
  assert.equal(report.status,'passed');
  assert.equal(report.daemonEndpointBound,true);
  assert.equal(report.immutableImagePinned,true);
  assert.deepEqual(report.handshake,{initialized:true,toolListReceived:true,readOnlyToolReply:true});
  assert.equal(report.toolCount,2);
  assert.equal(report.dockerBuildAttempted,false);
  assert.equal(report.cloudCallsMade,false);
  assert.equal(report.settingsModified,false);
  assert.equal(mock.calls.length,4);
  assert.equal(handshakeCount(mock.calls),1);
  assert.deepEqual(mock.calls[0].args,
    ['context','inspect','--format','{{json .Endpoints.docker.Host}}']);
  assert.deepEqual(mock.calls[1].args,
    ['--host',ENDPOINT,'info','--format','{{.OSType}}']);
  assert.equal(mock.calls[2].args[2],'image');
  assert.equal(mock.calls[2].args[4],'aws-emulator-mcp:0.4.0-beta.15');
  const args=mock.calls[3].args;
  assert.deepEqual(args.slice(0,11),
    ['--host',ENDPOINT,'run','--rm','-i','--pull','never','--network','none','--cap-drop','ALL']);
  assert.deepEqual(args.slice(-2),[IMAGE_ID,'mcp']);
  assert.ok(!args.includes('aws-emulator-mcp:0.4.0-beta.15'));
  assert.ok(!args.includes('--volume') && !args.includes('-v') && !args.includes('--mount'));
  assert.ok(mock.calls.slice(1).every(x=>x.options.pinned===true));
  const sent=mock.calls[3].input.trim().split('\n').map(x=>JSON.parse(x));
  assert.deepEqual(sent.map(x=>x.method),
    ['initialize','notifications/initialized','tools/list','tools/call']);
  assert.equal(sent[3].params.name,'emulator_status');
  assert.deepEqual(sent[3].params.arguments,{});
  assert.match(formatMcpConnection(report),/exact lowercase ok health body/);
  assert.match(formatMcpConnection(report),/NOT a Claude Desktop\/VS Code GUI verification/);
});

test('negative: truthy status flags with NOT_OK or otherwise wrong health body never pass',()=>{
  for(const body of ['NOT_OK','OK','Ok','ok\n','',null,false,{},undefined]) {
    const mock=mockDocker({replyBody:changedStatus('body',body)});
    const report=inspectMcpConnection({readiness:ready,
      expectedImageDigest:SOURCE,run:mock.run});
    assert.equal(report.passed,false,'should reject '+JSON.stringify(body));
    assert.equal(report.stage,'stdio');
    assert.equal(report.reason,'local-emulator-status-not-ready');
    assert.equal(report.handshake.readOnlyToolReply,false);
    assert.equal(report.dockerBuildAttempted,false);
    assert.equal(handshakeCount(mock.calls),1);
  }
});

test('negative: stale, missing or unchecked fingerprint blocks before ANY Docker command',()=>{
  for(const observed of [
    {imageReusable:false,imageSourceStatus:'mismatched'},
    {imageReusable:null,imageSourceStatus:'not-checked'},
    {imageReusable:true,imageSourceStatus:'unverified'}
  ]){
    const mock=mockDocker();
    const report=inspectMcpConnection({readiness:{...ready,...observed},
      expectedImageDigest:SOURCE,run:mock.run});
    assert.equal(report.status,'blocked');
    assert.equal(report.stage,'cached-image');
    assert.equal(report.dockerContainerAttempted,false);
    assert.equal(report.dockerBuildAttempted,false);
    assert.equal(report.nextCommand,'aws-emulator-mcp build');
    assert.equal(mock.calls.length,0);
  }
  const mock=mockDocker();
  const report=inspectMcpConnection({readiness:ready,run:mock.run});
  assert.equal(report.passed,false);
  assert.equal(report.stage,'cached-image');
  assert.equal(mock.calls.length,0);
});

test('negative: remote/malformed/ambiguous endpoint never reaches Docker info, image or run',()=>{
  for(const endpoint of [
    'tcp://198.51.100.4:2375','ssh://other-host',
    'unix:///tmp/../socket','unix://evil.host/socket',
    'unix:///some\nnewline/socket','npipe:////remote/pipe/docker_engine',
    null
  ]) {
    const mock=mockDocker({endpoint});
    const report=inspectMcpConnection({readiness:ready,
      expectedImageDigest:SOURCE,run:mock.run});
    assert.equal(report.passed,false,'should reject endpoint '+String(endpoint));
    assert.equal(report.stage,'daemon-binding');
    assert.equal(report.daemonEndpointBound,false);
    assert.equal(report.dockerContainerAttempted,false);
    assert.equal(mock.calls.length,1);
    assert.doesNotMatch(JSON.stringify(report),/198\.51\.100\.4|other-host|evil\.host/);
  }
  const mock=mockDocker({endpoint:ENDPOINT});
  const report=inspectMcpConnection({readiness:ready,
    expectedImageDigest:SOURCE,dockerHost:'unix:///tmp/different.sock',run:mock.run});
  assert.equal(report.stage,'daemon-binding');
  assert.equal(mock.calls.length,1);
});

test('positive: Unix paths with spaces and Windows named pipes stay one pinned CLI argument',()=>{
  for(const endpoint of [
    'unix:///Users/A Developer/.docker/run/docker.sock',
    'npipe:////./pipe/docker_engine'
  ]) {
    const mock=mockDocker({endpoint});
    const report=inspectMcpConnection({readiness:ready,
      expectedImageDigest:SOURCE,run:mock.run});
    assert.equal(report.passed,true);
    assert.deepEqual(mock.calls.filter(x=>x.args[0]==='--host').map(x=>x.args[1]),
      [endpoint,endpoint,endpoint]);
    assert.equal(mock.calls.at(-1).args.at(-2),IMAGE_ID);
    assert.ok(mock.calls.slice(1).every(x=>x.options.pinned===true));
  }
});

test('negative: rechecked daemon must be Linux and image ID + label must match exactly',()=>{
  for(const options of [
    {daemon:'windows'}, {daemon:'linux|injected'}, {daemon:'unknown'},
    {imageEvidence:'sha256:'+'c'.repeat(64)+'|'+SOURCE.slice(0,-1)+'b'},
    {imageEvidence:'sha256:short|'+SOURCE},
    {imageEvidence:IMAGE_ID+'|<no value>'},
    {imageEvidence:'sha256:'+'c'.repeat(64)+'|'+SOURCE+'\nSECRET'},
    {hostStatus:1}
  ]) {
    const mock=mockDocker(options);
    const report=inspectMcpConnection({readiness:ready,
      expectedImageDigest:SOURCE,run:mock.run});
    assert.equal(report.passed,false);
    assert.equal(handshakeCount(mock.calls),0);
    assert.equal(report.dockerContainerAttempted,false);
    assert.equal(report.immutableImagePinned,false);
    assert.equal(report.dockerBuildAttempted,false);
  }
});

test('negative: failing preflight prevents even Docker context resolution',()=>{
  for(const state of [null,{}, {...ready,emulatorReady:false},
    {...ready,checks:{docker:{passed:false}}}]) {
    const mock=mockDocker();
    const report=inspectMcpConnection({readiness:state,
      expectedImageDigest:SOURCE,run:mock.run});
    assert.equal(report.passed,false);
    assert.equal(report.stage,'prerequisites');
    assert.equal(report.dockerContainerAttempted,false);
    assert.match(report.nextCommand,/preflight --json/);
    assert.equal(mock.calls.length,0);
  }
});

test('negative: protocol errors, nonlocal status and missing replies fail closed',()=>{
  const variants=[
    'not-json\n',
    successfulReplies().replace('"id":3','"id":4'),
    successfulReplies().replace('"isError":false','"isError":true'),
    changedStatus('endpoint','https://aws.amazonaws.com'),
    changedStatus('running',false),
    successfulReplies().split('\n').slice(0,2).join('\n')
  ];
  for(const replyBody of variants) {
    const mock=mockDocker({replyBody});
    const report=inspectMcpConnection({readiness:ready,
      expectedImageDigest:SOURCE,run:mock.run});
    assert.equal(report.passed,false);
    assert.equal(report.status,'failed');
    assert.equal(report.stage,'stdio');
    assert.equal(report.handshake.readOnlyToolReply,false);
    assert.equal(report.dockerBuildAttempted,false);
    assert.doesNotMatch(JSON.stringify(report),/amazonaws\.com|not-json/);
  }
});

test('negative: Docker timeout, child crash and oversized tool output never leak private data',()=>{
  for(const outcome of [
    {status:null,error:new Error('secret AWS_SECRET_ACCESS_KEY=XXX'),stdout:'PRIVATE_PATH'},
    {status:3,stdout:'PRIVATE_PATH'},
    {status:0,stdout:'SECRET_PRIVATE_PATH'.repeat(18000)}
  ]) {
    const mock=mockDocker();
    const run=(args,input,opts)=>args[2]==='run' ? outcome : mock.run(args,input,opts);
    const report=inspectMcpConnection({readiness:ready,
      expectedImageDigest:SOURCE,run});
    assert.equal(report.passed,false);
    assert.equal(report.dockerBuildAttempted,false);
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_PATH|AWS_SECRET_ACCESS_KEY|XXX/);
  }
});

test('Docker child never inherits AWS secrets or ambient daemon redirects after binding',()=>{
  const source={
    PATH:'/bin',HOME:'/tmp/developer',
    DOCKER_HOST:'tcp://192.0.2.18:2375',DOCKER_CONTEXT:'remote-context',
    DOCKER_TLS_VERIFY:'1',DOCKER_CERT_PATH:'/tmp/private',
    AWS_ACCESS_KEY_ID:'ACCESS_TEST',AWS_SECRET_ACCESS_KEY:'SECRET_TEST',
    AWS_SESSION_TOKEN:'SESSION_TEST',AWS_PROFILE:'production'
  };
  const contextEnv=dockerChildEnv(source,false);
  assert.equal(contextEnv.DOCKER_CONTEXT,'remote-context');
  assert.equal(contextEnv.DOCKER_HOST,'tcp://192.0.2.18:2375');
  const pinned=dockerChildEnv(source,true);
  assert.deepEqual(Object.keys(pinned).sort(),['HOME','PATH']);
  for(const env of [contextEnv,pinned]){
    assert.ok(Object.keys(env).every(k=>!k.startsWith('AWS_')));
    assert.doesNotMatch(JSON.stringify(env),/SECRET_TEST|ACCESS_TEST|SESSION_TEST|production/);
  }
});

test('CLI with remote DOCKER_HOST exits 1 with sanitized JSON and no container',()=>{
  const r=spawnSync(process.execPath,[BIN,'connect-check','--json'],{
    encoding:'utf8',timeout:14000,
    env:{...process.env,DOCKER_HOST:'tcp://198.51.100.77:2375',
      AWS_SECRET_ACCESS_KEY:'DONOTPRINT_SECRET'}
  });
  assert.equal(r.status,1,r.stderr);
  assert.equal(r.stderr,'');
  const report=JSON.parse(r.stdout);
  assert.equal(report.stage,'prerequisites');
  assert.equal(report.daemonEndpointBound,false);
  assert.equal(report.dockerContainerAttempted,false);
  assert.equal(report.dockerBuildAttempted,false);
  assert.doesNotMatch(r.stdout,/198\.51\.100\.77|DONOTPRINT_SECRET/);
});

test('CLI rejects unsupported flags with no JSON or tool probes',()=>{
  for(const args of [['--build'],['--json','--json'],['--tool','s3_put_object']]){
    const r=spawnSync(process.execPath,[BIN,'connect-check',...args],{
      encoding:'utf8',timeout:10000,env:{...process.env,DOCKER_HOST:'tcp://192.0.2.22:2375'}
    });
    assert.equal(r.status,2);
    assert.equal(r.stdout,'');
    assert.match(r.stderr,/Usage: aws-emulator-mcp connect-check \[--json\]/);
  }
});
