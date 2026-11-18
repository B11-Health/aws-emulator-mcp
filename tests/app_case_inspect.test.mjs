import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'bin/aws-emulator-mcp.mjs');
const sample=path.join(ROOT,'examples/app-case/s3-upload.py');
const caseFile=path.join(ROOT,'examples/app-case/s3-object-write.json');

function pythonExists(){
  const variants=process.platform==='win32'?[['py','-3'],['python']]:
    [['python3.12'],['python3.11'],['python3.10'],['python3']];
  for(const [cmd,...args] of variants){
    const r=spawnSync(cmd,[...args,'--version'],{encoding:'utf8',timeout:3000});
    if(r.status===0){
      const match=/Python (\d+)\.(\d+)/.exec(r.stdout+r.stderr);
      if(match && (Number(match[1])>3 || Number(match[1])===3&&Number(match[2])>=10))return true;
    }
  }
  return false;
}
const available=pythonExists();
function cli(...args){
  return spawnSync(process.execPath,[CLI,...args],{encoding:'utf8',timeout:16000,
    env:{...process.env,DOCKER_HOST:'tcp://192.0.2.50:2375',AWS_ACCESS_KEY_ID:'SYNTHETIC_ONLY'}});
}

test('no-Docker read-only inspect discovers S3 call and reviews case', {skip:!available},()=>{
  const r=cli('app-case-inspect',sample,caseFile,'--json');
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stderr,'');
  const proof=JSON.parse(r.stdout);
  assert.equal(proof.sourceSha256,createHash('sha256').update(readFileSync(sample)).digest('hex'));
  assert.deepEqual(proof.calls.map(x=>x.service+'.'+x.operationCandidate),['s3.PutObject']);
  assert.deepEqual(proof.inputKeys,['bucket','data','key']);
  assert.deepEqual(proof.caseReview.callsWithoutExpectedCounters,[]);
  assert.deepEqual(proof.caseReview.missingInputKeys,[]);
  assert.equal(proof.starterCase.reviewRequired,true);
  assert.deepEqual(proof.starterCase.checks,[]);
  assert.equal(proof.caseReadyToRun,false);
  assert.equal(proof.executedSource,false);
  assert.equal(proof.executedAWSCalls,false);
  assert.doesNotMatch(r.stdout,/SYNTHETIC_ONLY/);
});

test('malformed CLI flags and URLs are rejected before a Docker call',{skip:!available},()=>{
  const attempts=[
    ['app-case-inspect'],
    ['app-case-inspect','https://example.com/module.py','--json'],
    ['app-case-inspect',sample,'--json','--json'],
    ['app-case-inspect',sample,'--badflag'],
    ['app-case-inspect',sample,'--entrypoint'],
    ['app-case-inspect',sample,'--entrypoint','__private'],
    ['app-case-inspect',sample,caseFile,'extra.txt'],
  ];
  for(const args of attempts){
    const r=cli(...args);
    assert.equal(r.status,2,args.join(' ')+' : '+r.stderr);
    assert.equal(r.stdout,'');
  }
});

test('static inspection never runs a malicious selected Python module',{skip:!available},()=>{
  const d=mkdtempSync(path.join(tmpdir(),'aws-mcp-inspect-'));
  try{
    const marker=path.join(d,'EXECUTED');
    const file=path.join(d,'module.py');
    writeFileSync(file,`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('not allowed')\ndef handle(clients, inputs):\n    clients['sqs'].send_message(QueueUrl=inputs['url'],MessageBody='test')\n`);
    const r=cli('app-case-inspect',file,'--json');
    assert.equal(r.status,0,r.stderr);
    const report=JSON.parse(r.stdout);
    assert.equal(report.executedSource,false);
    assert.deepEqual(report.calls.map(x=>x.service+'.'+x.method),['sqs.send_message']);
    assert.throws(()=>readFileSync(marker),{code:'ENOENT'});
  }finally{rmSync(d,{recursive:true,force:true});}
});
