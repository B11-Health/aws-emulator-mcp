import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateEvidence} from '../docs/proof-explorer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT,'docs');
const GUIDE = readFileSync(join(DOCS,'OFFICIAL_SKILL_TO_APP_PROOF_5MIN.md'),'utf8');
const read = p => readFileSync(join(ROOT,p));
const run = (args, env) => spawnSync(process.execPath,
  ['bin/aws-emulator-mcp.mjs',...args],
  {cwd:ROOT,encoding:'utf8',timeout:30000,env:{...process.env,...env}});

test('guide links resolve against this draft tree, including local heading anchors',()=>{
  const markdownLinks=[...GUIDE.matchAll(/\]\(([^)\s]+)\)/g)].map(m=>m[1]);
  assert.ok(markdownLinks.length>=16, 'too few cited source and artifact links');
  const external=[];
  for(const item of markdownLinks){
    if(/^https:\/\//.test(item)){external.push(item);continue;}
    assert.ok(!/^[a-z]+:/i.test(item),'unrecognized local scheme '+item);
    const [path,fragment] = item.split('#');
    const absolute = resolve(DOCS,path || '.');
    assert.ok(absolute.startsWith(ROOT+sep),'out-of-repo link '+item);
    assert.ok(existsSync(absolute),'missing local linked file '+item);
    if(fragment){
      const target = readFileSync(absolute,'utf8');
      const slugs=[...target.matchAll(/^#{1,6}\s+(.+)$/gm)].map(x=>
        x[1].toLowerCase().replace(/[^\w -]/g,'').replace(/\s+/g,'-'));
      assert.ok(slugs.includes(fragment),'missing heading fragment '+item);
    }
  }
  for(const necessary of [
    'https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-agent.html',
    'https://docs.aws.amazon.com/emulator/latest/userguide/check-project.html',
    'https://github.com/aws/aws-emulator/blob/main/.github/CONTRIBUTING.md',
    'https://github.com/aws/aws-emulator/issues/7',
    'https://github.com/B11-Health/aws-emulator-mcp/pull/73',
    'https://github.com/B11-Health/aws-emulator-mcp/pull/74'
  ])assert.ok(external.includes(necessary),'missing authoritative source '+necessary);
  assert.match(readFileSync(join(ROOT,'README.md'),'utf8'),/docs\/OFFICIAL_SKILL_TO_APP_PROOF_5MIN\.md/);
});

test('guide distinguishes AWS-native skill from separate trusted-local Docker labs',()=>{
  for(const token of [
    'aws agent-toolkit add-skill --skill-name aws-emulator --region us-east-1',
    '2.35.0','not the tagged', 'do not share a session',
    'onboard --offline --json','official-session --json','app-case-inspect',
    'app-case-compare','productionAwsValidated','receive.Messages.1',
    'AWS-Bench','No AWS account','Do not auto-prune'
  ]) assert.ok(GUIDE.toLowerCase().includes(token.toLowerCase()),'missing boundary '+token);
  assert.match(readFileSync(join(ROOT,'bin/aws-emulator-mcp.mjs'),'utf8'),
    /app-case-compare/);
});

test('documented offline-first command really succeeds without Docker or cloud calls',()=>{
  const home=mkdtempSync(join(tmpdir(),'aws-app-proof-handoff-'));
  try{
    const env={HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:home};
    const out=run(['onboard','--offline','--json'],env);
    assert.equal(out.status,0,out.stderr);
    const result=JSON.parse(out.stdout);
    assert.equal(result.status,'offline_first_win');
    assert.equal(result.firstWin.passed,true);
    assert.equal(result.firstWin.artifactCount,7);
    assert.equal(result.firstWin.syntheticContractSteps,14);
    assert.equal(result.firstWin.contractExecuted,false);
    assert.equal(result.readiness.dockerProbePerformed,false);
    assert.equal(result.safety.noDockerBuildOrRun,true);
    assert.equal(result.safety.noApplicationSourceExecution,true);
    assert.equal(result.safety.noCloudCalls,true);

    // A missing official session must fail closed, not be mistaken for app proof.
    const notConfigured=run(['official-session','--json'],env);
    assert.equal(notConfigured.status,1,notConfigured.stderr);
    const report=JSON.parse(notConfigured.stdout);
    assert.equal(report.status,'not_configured');
    assert.equal(report.localHealthPassed,false);
    assert.equal(report.credentialFilesRead,false);
    assert.equal(report.applicationBehaviorTested,false);
    assert.equal(report.cloudCallsMade,false);
  }finally{rmSync(home,{recursive:true,force:true});}
});

test('described application observation is grounded in current sample bytes and independent saved state checks',()=>{
  const record=JSON.parse(read('docs/evidence/app-case-aws-emulator-1.0.506.json'));
  const proof=record.comparison;
  const verify=validateEvidence(record);
  assert.equal(verify.ok,true,verify.reason);
  const sourceSha = file=>createHash('sha256').update(read(file)).digest('hex');
  assert.equal(proof.before.sourceSha256,sourceSha('examples/app-case/buggy.py'));
  assert.equal(proof.after.sourceSha256,sourceSha('examples/app-case/fixed.py'));
  assert.equal(record.before.caseSha256,record.after.caseSha256);
  assert.equal(record.before.caseSha256,proof.caseSha256);
  assert.equal(proof.regression.stepId,'receive');
  assert.equal(proof.regression.path,'Messages.1');
  assert.deepEqual(verify.beforeAssertions.map(a=>a.passed),[true,true,true,false]);
  assert.deepEqual(verify.afterAssertions.map(a=>a.passed),[true,true,true,true]);
  const successes=(side,service,operation)=>side.sdkCalls.find(c=>c.service===service&&c.operation===operation)?.successes;
  assert.equal(successes(proof.before,'sqs','SendMessage'),2);
  assert.equal(successes(proof.after,'sqs','SendMessage'),1);
  assert.equal(proof.before.cleanupPassed,true);
  assert.equal(proof.after.cleanupPassed,true);
  assert.equal(proof.productionAwsValidated,false);
});
