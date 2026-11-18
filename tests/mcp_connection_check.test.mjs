import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectMcpConnection, handshakeInput, formatMcpConnection} from '../scripts/mcp_connection_check.mjs';

const BIN=fileURLToPath(new URL('../bin/aws-emulator-mcp.mjs',import.meta.url));
const ready={
  emulatorReady:true,
  checks:{docker:{passed:true}},
  imageReusable:true,
  imageSourceStatus:'matched'
};
const reply=(id,result)=>JSON.stringify({jsonrpc:'2.0',id,result});
const status={installed:true,running:true,port:9297,endpoint:'https://127.0.0.1:9297'};
const successfulReplies = () => [
  reply(1,{protocolVersion:'2025-11-25',serverInfo:{name:'aws-emulator-mcp'}}),
  reply(2,{tools:[{name:'emulator_status'},{name:'emulator_doctor'}]}),
  reply(3,{content:[{type:'text',text:JSON.stringify(status)}],isError:false})
].join('\n')+'\n';

test('an explicit matched-image MCP check validates initialize, tool listing and read-only tool reply',()=>{
  const calls=[];
  const report=inspectMcpConnection({readiness:ready,fromCheckout:true,
    run:(args,input)=>{
      calls.push({args,input});
      return {status:0,stdout:successfulReplies()};
    }});
  assert.equal(report.passed,true);
  assert.equal(report.status,'passed');
  assert.deepEqual(report.handshake,{initialized:true,toolListReceived:true,readOnlyToolReply:true});
  assert.equal(report.toolCount,2);
  assert.equal(report.dockerBuildAttempted,false);
  assert.equal(report.cloudCallsMade,false);
  assert.equal(report.settingsModified,false);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].args.slice(0,9),['run','--rm','-i','--pull','never','--network','none','--cap-drop','ALL']);
  assert.equal(calls[0].args.at(-1),'mcp');
  assert.ok(calls[0].args.every(x=>!/^(build|pull|prune|--mount|-v|--volume|--privileged)$/.test(x)));
  const sent=calls[0].input.trim().split('\n').map(x=>JSON.parse(x));
  assert.deepEqual(sent.map(x=>x.method),['initialize','notifications/initialized','tools/list','tools/call']);
  assert.equal(sent[3].params.name,'emulator_status');
  assert.deepEqual(sent[3].params.arguments,{});
  assert.match(formatMcpConnection(report),/NOT a Claude Desktop\/VS Code GUI verification/);
});

test('unverified or stale cached image blocks all Docker run attempts and does not build',()=>{
  for(const observed of [
    {imageReusable:false,imageSourceStatus:'mismatched'},
    {imageReusable:null,imageSourceStatus:'not-checked'},
    {imageReusable:true,imageSourceStatus:'unverified'}
  ]){
    let runCount=0;
    const report=inspectMcpConnection({readiness:{...ready,...observed},
      run:()=>{runCount++;throw Error('must never reach Docker');}});
    assert.equal(report.status,'blocked');
    assert.equal(report.stage,'cached-image');
    assert.equal(report.reason,'source-matched-local-image-required');
    assert.equal(report.dockerContainerAttempted,false);
    assert.equal(report.dockerBuildAttempted,false);
    assert.equal(report.nextCommand,'aws-emulator-mcp build');
    assert.equal(runCount,0);
  }
});

test('missing/nonlocal/unverified Docker preflight rejects before attempting MCP',()=>{
  for(const state of [null,{}, {...ready,emulatorReady:false},
    {...ready,checks:{docker:{passed:false}}}]){
    let count=0;
    const report=inspectMcpConnection({readiness:state,
      run:()=>{count++;return {status:0,stdout:successfulReplies()};}});
    assert.equal(report.passed,false);
    assert.equal(report.stage,'prerequisites');
    assert.equal(report.dockerContainerAttempted,false);
    assert.match(report.nextCommand,/preflight --json/);
    assert.equal(count,0);
  }
});

test('malformed JSON, false tool result, wrong reply IDs and nonlocal status fail closed',()=>{
  const changeStatus=(key,value)=>{
    const lines=successfulReplies().trim().split('\n');
    const response=JSON.parse(lines[2]);
    const payload=JSON.parse(response.result.content[0].text);
    payload[key]=value;
    response.result.content[0].text=JSON.stringify(payload);
    lines[2]=JSON.stringify(response);
    return lines.join('\n')+'\n';
  };
  const variants=[
    'not-json\n',
    successfulReplies().replace('"id":3','"id":4'),
    successfulReplies().replace('"isError":false','"isError":true'),
    changeStatus('endpoint','https://aws.amazonaws.com'),
    changeStatus('running',false),
    successfulReplies().split('\n').slice(0,2).join('\n'),
  ];
  for(const stdout of variants){
    const report=inspectMcpConnection({readiness:ready,run:()=>({status:0,stdout})});
    assert.equal(report.passed,false);
    assert.equal(report.status,'failed');
    assert.equal(report.stage,'stdio');
    assert.equal(report.handshake.readOnlyToolReply,false);
    assert.equal(report.dockerBuildAttempted,false);
    assert.doesNotMatch(JSON.stringify(report),/amazonaws\.com|not-json/);
  }
});

test('timeout, child crash, thrown error and large output never leak child output',()=>{
  for(const run of [
    ()=>({status:null,error:new Error('secret AWS_SECRET_ACCESS_KEY=XXX'),stdout:'PRIVATE_PATH'}),
    ()=>({status:3,stdout:'PRIVATE_PATH'}),
    ()=>{throw Error('PRIVATE_PATH');},
    ()=>({status:0,stdout:'SECRET_PRIVATE_PATH'.repeat(18000)})
  ]){
    const report=inspectMcpConnection({readiness:ready,run});
    assert.equal(report.passed,false);
    assert.equal(report.dockerBuildAttempted,false);
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE_PATH|AWS_SECRET_ACCESS_KEY|XXX/);
  }
});

test('CLI with remote DOCKER_HOST exits 1 with sanitized JSON and never attempts MCP container',()=>{
  const value='DONOTPRINT_SECRET';
  const r=spawnSync(process.execPath,[BIN,'connect-check','--json'],{
    encoding:'utf8',timeout:14000,
    env:{...process.env,DOCKER_HOST:'tcp://198.51.100.77:2375',
      AWS_SECRET_ACCESS_KEY:value}
  });
  assert.equal(r.status,1,r.stderr);
  assert.equal(r.stderr,'');
  const report=JSON.parse(r.stdout);
  assert.equal(report.stage,'prerequisites');
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
