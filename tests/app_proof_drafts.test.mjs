import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'bin/aws-emulator-mcp.mjs');
const cli=(...args)=>spawnSync(process.execPath,[CLI,'app-guide',...args],{
  encoding:'utf8',timeout:24000,env:{...process.env,DOCKER_HOST:'tcp://198.51.100.21:2375'}});
const sources={
  s3:`clients['s3'].put_object(Bucket=inputs['bucket'],Key=inputs['key'],Body=inputs['data'])`,
  sqs:`clients['sqs'].send_message(QueueUrl=inputs['queueUrl'],MessageBody=inputs['body'])`,
  dynamodb:`clients['dynamodb'].put_item(TableName=inputs['table'],Item={'id':{'S':inputs['id']}})`,
};
function complete(template,service){
  const result=structuredClone(template);
  delete result.reviewRequired;
  const inputs={s3:{bucket:{$fixture:'bucket'},key:'synthetic-key',data:'synthetic-data'},
    sqs:{queueUrl:{$ref:'queue.QueueUrl'},body:'synthetic-event'},
    dynamodb:{table:{$fixture:'table'},id:{$fixture:'id'}}};
  result.invoke.inputs=inputs[service];
  if(service==='s3'){
    result.checks[0].parameters.Key='synthetic-key';
    result.cleanup[0].parameters.Key='synthetic-key';
  }
  return result;
}
for(const [service,operation,check,cleanup] of [
  ['s3','PutObject','HeadObject',['DeleteObject','DeleteBucket']],
  ['sqs','SendMessage','ReceiveMessage',['DeleteQueue']],
  ['dynamodb','PutItem','GetItem',['DeleteTable']],
])test(`${service}: own handler produces review-only state and expected-red pair`,()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'byo-proof-'));
  try{
    const app=path.join(folder,'external.py');
    writeFileSync(app,`def handle(clients, inputs):\n    ${sources[service]}\n`);
    const positive=path.join(folder,'case.json');
    const negative=path.join(folder,'case.expected-red.json');
    const response=cli(app,'--draft-proof',positive,'--json');
    assert.equal(response.status,0,response.stderr);
    const report=JSON.parse(response.stdout);
    assert.equal(report.templateOperation,`${service}.${operation}`);
    assert.equal(report.proofDraftWritten,true);
    assert.equal(report.expectedRedDraftWritten,true);
    assert.equal(report.approvalToken,null);
    assert.equal(report.readyForApproval,false);
    assert.equal(report.executedSource,false);
    assert.equal(report.executedAWSCalls,false);
    const green=JSON.parse(readFileSync(positive,'utf8'));
    const red=JSON.parse(readFileSync(negative,'utf8'));
    assert.equal(green.reviewRequired,true);
    assert.equal(red.reviewRequired,true);
    assert.deepEqual(green.cleanup,red.cleanup);
    assert.deepEqual(green.setup,red.setup);
    assert.deepEqual(green.cleanup.map(x=>x.operation),cleanup);
    assert.equal(green.checks[0].operation,check);
    assert.equal(green.regression.path,red.regression.path);
    assert.equal(green.checks[0].expect.assertions[0].exists,true);
    assert.equal(red.checks[0].expect.assertions[0].exists,false);
    for(const file of [positive,negative]){
      const state=cli(app,file,'--json');
      assert.equal(state.status,0,state.stderr);
      const inspection=JSON.parse(state.stdout);
      assert.equal(inspection.readyForApproval,false);
      assert.equal(inspection.approvalToken,null);
      assert.ok(inspection.reviewGaps.includes('formal_case_schema_not_validated'));
    }
    // The developer supplies synthetic values and explicitly removes the
    // review marker. Nothing here invokes the trusted source or Docker.
    writeFileSync(positive,JSON.stringify(complete(green,service)));
    writeFileSync(negative,JSON.stringify(complete(red,service)));
    const approval=JSON.parse(cli(app,positive,'--json').stdout);
    const negativeApproval=JSON.parse(cli(app,negative,'--json').stdout);
    assert.equal(approval.status,'explicit_approval_required');
    assert.equal(negativeApproval.status,'explicit_approval_required');
    assert.equal(approval.formalCaseSchemaValidated,true);
    assert.equal(negativeApproval.formalCaseSchemaValidated,true);
    assert.match(approval.approvalToken,/^[a-f0-9]{64}$/);
    assert.notEqual(approval.approvalToken,negativeApproval.approvalToken);
    // A completed template still requires a separate developer-initiated
    // --run with the current exact source/case approval token.
    const stale=cli(app,positive,'--run','--approve','0'.repeat(64));
    assert.equal(stale.status,2);
    assert.match(stale.stderr,/token mismatch/);
  }finally{rmSync(folder,{recursive:true,force:true});}
});

test('unsupported, dynamic, or multi-write sources are never scaffolded',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'byo-proof-reject-'));
  try {
    const sources={
      dynamic:`def handle(clients, inputs):\n    clients[inputs['service']].put_object(Bucket='x')\n`,
      multi:`def handle(clients, inputs):\n    clients['s3'].put_object(Bucket='x')\n    clients['sqs'].send_message(QueueUrl='x', MessageBody='x')\n`,
      unsupported:`def handle(clients, inputs):\n    clients['s3'].delete_object(Bucket='x', Key='x')\n`,
    };
    for(const [name,code] of Object.entries(sources)) {
      const source=path.join(folder,`${name}.py`);
      const positive=path.join(folder,`${name}.json`);
      const red=path.join(folder,`${name}.expected-red.json`);
      writeFileSync(source,code);
      const result=cli(source,'--draft-proof',positive,'--json');
      assert.equal(result.status,2,result.stdout+result.stderr);
      assert.equal(existsSync(positive),false);
      assert.equal(existsSync(red),false);
    }
  }finally {rmSync(folder,{recursive:true,force:true});}
});

test('existing output files are never replaced, and partial pairs roll back',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'byo-proof-collision-'));
  try {
    const source=path.join(folder,'developer.py');
    const positive=path.join(folder,'candidate.json');
    const negative=path.join(folder,'candidate.expected-red.json');
    const sentinel='PRESERVE_EXISTING_CONTENT';
    writeFileSync(source,`def handle(clients, inputs):\n    ${sources.s3}\n`);
    writeFileSync(negative,sentinel);
    const blockedRed=cli(source,'--draft-proof',positive);
    assert.equal(blockedRed.status,2);
    assert.equal(readFileSync(negative,'utf8'),sentinel);
    assert.equal(existsSync(positive),false);
    rmSync(negative);
    writeFileSync(positive,sentinel);
    const blockedPositive=cli(source,'--draft-proof',positive);
    assert.equal(blockedPositive.status,2);
    assert.equal(readFileSync(positive,'utf8'),sentinel);
    assert.equal(existsSync(negative),false);
  }finally {rmSync(folder,{recursive:true,force:true});}
});

test('no remote URLs, implicit approval, or combining draft with execution',()=>{
  const token='a'.repeat(64);
  for(const args of [
    ['file.py','--draft-proof','https://example.org/case.json'],
    ['https://example.org/source.py','--draft-proof','case.json'],
    ['file.py','--draft-proof','case.json','--run','--approve',token],
    ['file.py','--draft-proof','case.json','--draft','other.json'],
    ['file.py','case.json','--draft-proof','other.json'],
    ['file.py','--draft-proof','case.json','--draft-proof','other.json'],
  ]){
    const result=cli(...args);
    assert.equal(result.status,2,result.stdout+result.stderr);
  }
});

test('static proof scaffolding does not execute selected Python top-level code',()=>{
  const folder=mkdtempSync(path.join(tmpdir(),'byo-proof-static-only-'));
  try{
    const source=path.join(folder,'developer.py'),marker=path.join(folder,'SIDE_EFFECT');
    const positive=path.join(folder,'case.json');
    writeFileSync(source,`from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\ndef handle(clients, inputs):\n    ${sources.sqs}\n`);
    const drafted=cli(source,'--draft-proof',positive,'--json');
    assert.equal(drafted.status,0,drafted.stderr);
    assert.equal(existsSync(marker),false);
    assert.equal(existsSync(positive),true);
    assert.equal(JSON.parse(drafted.stdout).approvalToken,null);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
