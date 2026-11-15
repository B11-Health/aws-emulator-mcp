import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync,
  symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareArchitecture, generateDiffSvg, githubReview,
  markdownSummary, writeReview
} from '../scripts/architecture_review.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture=path.join(ROOT,'examples/architecture/review');
const before=JSON.parse(readFileSync(path.join(fixture,'before.json'),'utf8'));
const after=JSON.parse(readFileSync(path.join(fixture,'after.json'),'utf8'));
const signature=text=>createHash('sha256').update(text).digest('hex');
const deep=o=>structuredClone(o);

function workspace(fn) {
  const dir=mkdtempSync(path.join(tmpdir(),'aws-mcp-arch-review-'));
  try{return fn(dir);}
  finally{rmSync(dir,{recursive:true,force:true});}
}
function cmd(args, dir=ROOT) {
  return spawnSync(process.execPath,
    [path.join(ROOT,'bin/aws-emulator-mcp.mjs'),'architecture','review',...args],
    {cwd:dir,encoding:'utf8',timeout:23000,stdio:['ignore','pipe','pipe'],
     env:{...process.env, AWS_ACCESS_KEY_ID:'INVALID_TEST_ONLY',
      DOCKER_HOST:'tcp://192.0.2.5:2375'}}
  );
}

test('resource adds, potential replacement and unchanged resource are differentiated',()=>{
  const report=compareArchitecture(before,after);
  assert.equal(report.reviewKind,'local-blueprint-comparison');
  assert.equal(report.awsDeployment,false);
  assert.equal(report.cloudFormationChangeSet,false);
  assert.equal(report.awsAccountAccess,false);
  assert.equal(report.emulatorTestExecuted,false);
  assert.deepEqual(report.counts,
    {unchanged:1,added:1,modified:1,removed:0,conceptual:0});
  assert.equal(report.highRiskCount,1);
  const m=Object.fromEntries(report.changes.map(x=>[x.id,x]));
  assert.equal(m.FulfillmentQueue.status,'added');
  assert.equal(m.OrdersTable.status,'modified');
  assert.equal(m.OrdersTable.risk,'high');
  assert.match(m.OrdersTable.reason,/potential replacement/);
  assert.equal(m.ReceiptsBucket.status,'unchanged');
  assert.match(markdownSummary(report),/not an AWS CloudFormation change set/);
});

test('removing S3 or DynamoDB is high-risk even if Retain might leave resources billable',()=>{
  for(const type of ['s3-bucket','dynamodb-table','sqs-queue']) {
    const a=deep(after);
    const target=a.resources.find(x=>x.type===type);
    a.resources=a.resources.filter(x=>x.id!==target.id);
    a.flows=a.flows.filter(x=>x.to!==target.id);
    const change=compareArchitecture(after,a).changes.find(x=>x.id===target.id);
    assert.equal(change.status,'removed');
    assert.equal(change.risk,'high');
    assert.match(change.reason,/Retain|message loss/);
  }
});

test('changing conceptual flow or labels does not imply physical infrastructure change',()=>{
  const a=deep(after);
  a.flows.find(x=>x.to==='FulfillmentQueue').label='Enqueue events';
  a.resources.find(x=>x.id==='OrdersTable').label='Active orders';
  const x=compareArchitecture(after,a);
  assert.equal(x.highRiskCount,0);
  assert.equal(x.counts.conceptual,2);
  assert.equal(x.counts.unchanged,1);
  assert.ok(x.changes.every(c=>c.risk==='none'));
});

test('reordered manifests give byte-identical diff reports and diagrams',()=>{
  const a=deep(after);const b=deep(before);
  a.resources.reverse();a.flows.reverse();b.resources.reverse();b.flows.reverse();
  const report=compareArchitecture(b,a);
  assert.deepEqual(report,compareArchitecture(before,after));
  assert.equal(generateDiffSvg(b,a,report),
    generateDiffSvg(before,after,compareArchitecture(before,after)));
});

test('a new blueprint with no base manifest is explicitly marked as new',()=>{
  const report=compareArchitecture(null,after);
  assert.equal(report.beforePresent,false);
  assert.equal(report.highRiskCount,0);
  assert.equal(report.counts.added,3);
  assert.ok(report.changes.every(x=>x.status==='added'));
  const svg=generateDiffSvg(null,after,report);
  assert.match(svg,/No baseline manifest/);
  workspace(home=>{
    const output=writeReview(null,after,home,'first-blueprint');
    assert.equal(output.fileCount,11);
    assert.match(readFileSync(path.join(home,'first-blueprint/before-diagram.svg'),'utf8'),/<svg /);
    assert.match(readFileSync(path.join(home,'first-blueprint/before-diagram.drawio'),'utf8'),/<mxfile /);
    assert.match(readFileSync(path.join(home,'first-blueprint/report.json'),'utf8'),/"beforePresent": false/);
  });
});

test('SVG is valid source with no external images, scripts or unsafe label insertion',()=>{
  const a=deep(after);
  a.resources[2].label='Queue <unsafe> & "quoted"';
  const report=compareArchitecture(before,a);
  const svg=generateDiffSvg(before,a,report);
  assert.match(svg,/Queue &lt;unsafe&gt; &amp; &quot;quoted&quot;/);
  assert.doesNotMatch(svg,/<script|<foreignObject|<image|<iframe/i);
  for(const id of ['OrdersTable','ReceiptsBucket']){
    assert.equal((svg.match(new RegExp('data-node-id="'+id+'"','g'))||[]).length,2);
  }
  assert.equal((svg.match(/data-node-id="FulfillmentQueue"/g)||[]).length,1);
});

test('committed reference assets exactly match the compiler outputs and hashes',()=>{
  const report=compareArchitecture(before,after);
  assert.equal(report.highRiskCount,1);
  workspace(home=>{
    const actual=writeReview(before,after,home,'report');
    assert.equal(actual.fileCount,11);
    for(const file of ['architecture-diff.svg','report.json','summary.md']){
      assert.equal(readFileSync(path.join(home,'report',file),'utf8'),
        readFileSync(path.join(fixture,'reference',file),'utf8'),file);
    }
    const data=JSON.parse(readFileSync(path.join(home,'report/report.json'),'utf8'));
    for(const [filename, info] of Object.entries(data.artifacts)){
      const body=readFileSync(path.join(home,'report',filename));
      assert.equal(info.sha256,signature(body),filename);
    }
    assert.equal(Object.keys(data.artifacts).length,10);
    assert.equal(data.fileCount,undefined);
  });
});

test('review output is idempotent but differing existing files fail closed',()=>{
  workspace(home=>{
    const first=writeReview(before,after,home,'review');
    const second=writeReview(before,after,home,'review');
    assert.deepEqual(first,second);
    const target=path.join(home,'review/summary.md');
    writeFileSync(target,'do not overwrite this\n');
    assert.throws(()=>writeReview(before,after,home,'review'),/Refusing to overwrite/);
    assert.equal(readFileSync(target,'utf8'),'do not overwrite this\n');
  });
});

test('CLI emits real report and optionally returns failing status for high risk',()=>{
  workspace(home=>{
    writeFileSync(path.join(home,'before.json'),JSON.stringify(before));
    writeFileSync(path.join(home,'after.json'),JSON.stringify(after));
    const ok=cmd(['before.json','after.json','preview','--json'],home);
    assert.equal(ok.status,0,ok.stderr);
    const result=JSON.parse(ok.stdout);
    assert.equal(result.fileCount,11);
    assert.equal(result.highRiskCount,1);
    assert.ok(existsSync(path.join(home,'preview/architecture-diff.svg')));
    const strict=cmd(['before.json','after.json','strict','--fail-on-risk'],home);
    assert.equal(strict.status,2,strict.stderr);
    const text=readFileSync(path.join(home,'strict/summary.md'),'utf8');
    assert.match(text,/1 high-risk review flags/);
    const bad=cmd(['../out.json','after.json'],home);
    assert.equal(bad.status,1);
    assert.doesNotMatch(bad.stderr,/AWS_ACCESS_KEY_ID|INVALID_TEST_ONLY/);
  });
});

test('GitHub action uses explicit fixture baseline without requiring any AWS identity',()=>{
  workspace(home=>{
    mkdirSync(path.join(home,'fixtures'));
    writeFileSync(path.join(home,'fixtures/before.json'),JSON.stringify(before));
    writeFileSync(path.join(home,'fixtures/after.json'),JSON.stringify(after));
    const summary=path.join(home,'job-summary.md');
    const ok=githubReview({
      workspace:home,
      beforePath:'fixtures/before.json',
      manifestPath:'fixtures/after.json',
      output:'reports/preview',summaryPath:summary,failOnRisk:'never'
    });
    assert.equal(ok.failed,false);
    assert.equal(ok.report.highRiskCount,1);
    assert.match(readFileSync(summary,'utf8'),/Review priority/);
    const high=githubReview({
      workspace:home,
      beforePath:'fixtures/before.json',
      manifestPath:'fixtures/after.json',
      output:'reports/strict',failOnRisk:'high'
    });
    assert.equal(high.failed,true);
  });
});

test('GitHub base SHA mode reads only committed JSON without executing repository scripts',()=>{
  workspace(home=>{
    const git=(...args)=>spawnSync('git',args,{cwd:home,encoding:'utf8',shell:false,timeout:10000});
    assert.equal(git('init','-q').status,0);
    assert.equal(git('config','user.name','Architecture Review QA').status,0);
    assert.equal(git('config','user.email','qa@example.invalid').status,0);
    mkdirSync(path.join(home,'.aws-emulator'));
    const file=path.join(home,'.aws-emulator/architecture.json');
    writeFileSync(file,JSON.stringify(before));
    assert.equal(git('add','.aws-emulator/architecture.json').status,0);
    assert.equal(git('-c','commit.gpgsign=false','commit','-qm','base').status,0);
    const base=git('rev-parse','HEAD').stdout.trim();
    writeFileSync(file,JSON.stringify(after));
    const result=githubReview({
      workspace:home,baseSha:base,manifestPath:'.aws-emulator/architecture.json',
      output:'reports/from-git'
    });
    assert.equal(result.report.highRiskCount,1);
    assert.equal(result.report.beforeSha256!==null,true);
    assert.throws(()=>githubReview({
      workspace:home,baseSha:'not-a-sha',manifestPath:'.aws-emulator/architecture.json',
      output:'reports/bad'
    }),/invalid trusted base commit/);
  });
});

test('GitHub base SHA mode allows newly added architecture file, rejects unknown base commit',()=>{
  workspace(home=>{
    const git=(...args)=>spawnSync('git',args,{cwd:home,encoding:'utf8',shell:false,timeout:10000});
    git('init','-q');git('config','user.name','QA');git('config','user.email','qa@example.invalid');
    writeFileSync(path.join(home,'README.md'),'base');
    git('add','README.md');git('-c','commit.gpgsign=false','commit','-qm','base');
    const base=git('rev-parse','HEAD').stdout.trim();
    mkdirSync(path.join(home,'.aws-emulator'));
    writeFileSync(path.join(home,'.aws-emulator/architecture.json'),JSON.stringify(after));
    const res=githubReview({workspace:home,baseSha:base});
    assert.equal(res.report.beforePresent,false);
    assert.equal(res.report.counts.added,3);
    assert.throws(()=>githubReview({workspace:home,baseSha:'f'.repeat(40),output:'reports/bogus'}),/Base commit not present/);
  });
});

test('invalid/credential-bearing blueprints and unsafe paths never generate evidence',()=>{
  workspace(home=>{
    const bad=deep(after);bad.iamPolicy={Action:'*'};
    const dangerous=deep(after);dangerous.resources[0].label='AWS_SECRET_ACCESS_KEY=secret';
    for(const m of [bad,dangerous]){
      assert.throws(()=>writeReview(before,m,home,'reject'),/Resource|invalid|sensitive/i);
    }
    for(const p of ['../escapes','/tmp/absolute','.git/cache',
      'node_modules/reports','a\\windows','reports/../outside']) {
      assert.throws(()=>writeReview(before,after,home,p),/Paths|escapes|allowed/);
    }
    assert.equal(existsSync(path.join(home,'reject')),false);
    if(process.platform!=='win32'){
      mkdirSync(path.join(home,'original'));
      symlinkSync(path.join(home,'original'),path.join(home,'linked'),'dir');
      assert.throws(()=>writeReview(before,after,home,'linked/output'),/Symlinked/);
    }
  });
});

test('source Action is pinned, read-only and keeps PR code execution outside the trust boundary',()=>{
  const yaml=readFileSync(path.join(ROOT,'.github/actions/architecture-review/action.yml'),'utf8');
  assert.match(yaml,/actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.match(yaml,/actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(yaml,/github\.action_path/);
  assert.match(yaml,/\.\.\/\.\.\/\.\.\/scripts\/architecture_review\.mjs/);
  assert.doesNotMatch(yaml,/secrets\.|pull_request_target/);
  const wf=readFileSync(path.join(ROOT,'.github/workflows/architecture-review-selftest.yml'),'utf8');
  assert.match(wf,/contents: read/);
  assert.match(wf,/pull_request:/);
  assert.match(wf,/uses: \.\/\.github\/actions\/architecture-review/);
});
