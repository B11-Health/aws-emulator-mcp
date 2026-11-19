import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const html=readFileSync(join(ROOT,'docs/index.html'),'utf8');
const css=readFileSync(join(ROOT,'docs/demo-studio.css'),'utf8');
const js=readFileSync(join(ROOT,'docs/demo-studio.js'),'utf8');
const readme=readFileSync(join(ROOT,'README.md'),'utf8');
const cli=readFileSync(join(ROOT,'bin/aws-emulator-mcp.mjs'),'utf8');
const server=readFileSync(join(ROOT,'src/aws_emulator_mcp/server.py'),'utf8');
const R3='release/agent-team-preview-r3-20261118';
const R3_SHA='d577c490f7c6d92c9ac9040913728bf700b52244';
const BETA='v0.4.0-beta.15';
const BETA_SHA='12bae624be4cd9d428844dcfd17d24ea38cbc788';
const REPO='https://github.com/B11-Health/aws-emulator-mcp.git';
const goals={
  api:{dir:'aws-mcp-api',branch:R3,sha:R3_SHA,args:["'config'","'copilot'"]},
  app:{dir:'aws-mcp-app',branch:R3,sha:R3_SHA,
    args:["'app-guide'","'examples/app-case/s3-upload.py'","'--json'"]},
  architecture:{dir:'aws-mcp-architecture',branch:BETA,sha:BETA_SHA,
    args:["'architecture'","'demo'"]},
  gaps:{dir:'aws-mcp-gaps',branch:R3,sha:R3_SHA,
    args:["'preflight'","'--json'"],optional:["'coverage'","'s3'","'--json'"]},
};
const names=Object.keys(goals);
function section(source=html){
  const a=source.indexOf('<section class="section wrap goal-router"');
  const b=source.indexOf('<section class="section wrap app-proof"',a);
  return a<0||b<0?'':source.slice(a,b);
}
function card(goal,source=html){
  const pattern=new RegExp('<details class="goal-card" id="goal-'+goal+'" name="developer-goal"(?: open)?>[\\s\\S]*?<\\/details>');
  return section(source).match(pattern)?.[0]||'';
}
function snippets(source=html){
  const found=new Map();
  const re=/<pre id="([^"]+)" tabindex="0"><code>([^<]+)<\/code><\/pre><button class="copy-button" type="button" data-copy="([^"]+)" aria-label="([^"]+)">([^<]+)<\/button>/g;
  for(const [,id,code,copy,aria,text] of section(source).matchAll(re)){
    found.set(id,{code:code.trim(),copy,aria,text});
  }
  return found;
}
function id(goal,type){return 'goal-'+goal+'-'+type;}
function guardScript(command){
  assert.ok(command.startsWith('node -e "'));
  assert.ok(command.endsWith('"'));
  const script=command.slice('node -e "'.length,-1);
  assert.ok(!script.includes('"') && !script.includes('$'));
  return script;
}
function inspect(source=html){
  const problems=[];
  const text=section(source),cmd=snippets(source);
  if(!text.includes('not yet a published update')) problems.push('preview disclaimer missing');
  if(!text.includes('same parent directory')) problems.push('safe parent directory instruction missing');
  if(!text.includes('Never paste a Clone, Verify, and Run sequence together')) problems.push('failed-clone warning missing');
  if(/https:\/\/b11-health\.github\.io\/aws-emulator-mcp\/#goals/.test(text)) problems.push('public premature link');
  for(const [goal,spec] of Object.entries(goals)){
    const shape=card(goal,source);
    if(!shape.includes('<summary>') || !shape.includes('name="developer-goal"') ||
       !shape.includes('<p class="goal-next"><strong>Next:</strong>'))
      problems.push('missing disclosure or next step '+goal);
    const types=['clone','verify','run'];
    if(spec.optional)types.push('probe');
    for(const type of types){
      const key=id(goal,type),row=cmd.get(key);
      if(!row || row.copy!==key || !row.aria || !row.text){
        problems.push('missing accessible separate copy '+key);
        continue;
      }
      if(row.code.includes('\n') || row.code.includes('\r') || row.code.startsWith('cd '))
        problems.push('multiline or cd paste risk '+key);
    }
    if(cmd.get(id(goal,'clone'))?.code!=='git clone --depth 1 --branch '+spec.branch+' '+REPO+' '+spec.dir)
      problems.push('wrong branch/tag clone '+goal);
    if(cmd.get(id(goal,'verify'))?.code!=='git -C '+spec.dir+' rev-parse HEAD')
      problems.push('wrong verification checkout '+goal);
    if(!shape.includes('<code>'+spec.sha+'</code>')) problems.push('invisible expected pinned SHA '+goal);
    const specs=[['run',spec.args]];
    if(spec.optional)specs.push(['probe',spec.optional]);
    for(const [type,args] of specs){
      const key=id(goal,type),code=cmd.get(key)?.code||'';
      if(!code.startsWith('node -e "') || !code.endsWith('"')){
        problems.push('unguarded node execution '+key);
        continue;
      }
      for(const required of [
        "d='"+spec.dir+"'","h='"+spec.sha+"'",
        "g(['rev-parse','HEAD'])!==h",
        "g(['rev-parse','--show-toplevel'])",
        "g(['status','--porcelain','--untracked-files=all'])!==''",
        "p.resolve(d,'bin/aws-emulator-mcp.mjs')",
        "{cwd:p.resolve(d),stdio:'inherit'}",
        "'Refusing unverified checkout: '"
      ])if(!code.includes(required)) problems.push('missing runtime protection '+key+' '+required);
      if(!code.includes(args.join(',')))problems.push('wrong version-specific command '+key);
      if(code.includes('$'))problems.push('shell interpolation hazard '+key);
    }
  }
  if(!card('api',source).includes('not in beta.15')||
     !card('api',source).includes('does <strong>not</strong> validate'))
    problems.push('API preview fidelity warning missing');
  if(!card('app',source).includes('non-runnable')||
     !card('app',source).includes('Docker is not a hostile-code sandbox'))
    problems.push('trusted source warning missing');
  if(!card('architecture',source).includes('not a deployed stack'))
    problems.push('offline architecture disclaimer missing');
  if(!card('gaps',source).includes('can automatically download/build')||
     !card('gaps',source).includes('not</strong> full service support'))
    problems.push('optional signed build warning missing');
  return problems;
}
function exec(exe,args,cwd){
  return spawnSync(exe,args,{cwd,encoding:'utf8',timeout:15000,
    env:{...process.env,DOCKER_HOST:'tcp://198.51.100.1:2375'}});
}
function git(root,args){
  const r=exec('git',args,root);
  assert.equal(r.status,0,r.stderr);
  return r.stdout.trim();
}
function fixture(root,goal){
  const directory=join(root,goals[goal].dir);
  mkdirSync(join(directory,'bin'),{recursive:true});
  git(root,['init',directory]);
  git(root,['-C',directory,'config','user.email','qa@example.invalid']);
  git(root,['-C',directory,'config','user.name','QA fixture']);
  const marker=join(root,'executed-'+goal+'.marker');
  const script="import{writeFileSync}from'node:fs';import{resolve}from'node:path';writeFileSync(resolve('..','executed-"+goal+".marker'),'ran');\n";
  writeFileSync(join(directory,'bin/aws-emulator-mcp.mjs'),script);
  git(root,['-C',directory,'add','.']);
  git(root,['-C',directory,'commit','-m','Safe test fixture']);
  return {directory,marker,sha:git(root,['-C',directory,'rev-parse','HEAD'])};
}

test('four native disclosures and thirteen distinct accessible copy buttons work without telemetry',()=>{
  assert.deepEqual(inspect(),[]);
  assert.equal((section().match(/<details class="goal-card"/g)||[]).length,4);
  assert.equal((section().match(/<summary>/g)||[]).length,4);
  assert.equal((section().match(/ name="developer-goal" open>/g)||[]).length,1);
  assert.equal(snippets().size,13);
  assert.match(css,/\.goal-card>summary:focus-visible/);
  assert.match(css,/\.goal-safe-steps/);
  assert.match(css,/@media\(max-width:600px\)\{\.goal-step/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(js,/document\.querySelectorAll\('\[data-copy\]'\)/);
  assert.doesNotMatch(js,/fetch\(|sendBeacon|XMLHttpRequest|google-analytics|gtag\(/);
  assert.match(readme,/separate Clone → Verify → Run buttons/);
  assert.match(readme,/If a clone fails because the directory exists, \*\*stop\*\*/);
});
test('branch/tag pins and version-specific arguments are enforced inside one-line run buttons',()=>{
  assert.deepEqual(inspect(),[]);
  for(const [goal,spec] of Object.entries(goals)){
    const c=snippets();
    assert.equal(c.get(id(goal,'clone')).code,
      'git clone --depth 1 --branch '+spec.branch+' '+REPO+' '+spec.dir);
    assert.equal(c.get(id(goal,'verify')).code,'git -C '+spec.dir+' rev-parse HEAD');
    guardScript(c.get(id(goal,'run')).code);
  }
  assert.equal(goals.architecture.sha,BETA_SHA);
  assert.equal(goals.api.sha,R3_SHA);
  assert.match(cli,/if \(command === 'app-guide'\)/);
  assert.match(cli,/if \(command === 'architecture'\)/);
  assert.match(cli,/if \(command === 'coverage'\)/);
  assert.match(server,/spec\("aws_sdk_preview"/);
});
test('negative static QA rejects branch changes, unguarded commands and removed warnings',()=>{
  const cases=[
    ['--branch '+R3+' '+REPO+' aws-mcp-api','--branch '+BETA+' '+REPO+' aws-mcp-api','wrong branch/tag'],
    ["h='"+R3_SHA+"'","h='"+BETA_SHA+"'","missing runtime protection"],
    ["g(['status','--porcelain','--untracked-files=all'])!==''",
     "g(['status','--porcelain','--untracked-files=all'])==='x'",
     'missing runtime protection'],
    ["g(['rev-parse','--show-toplevel'])","g(['rev-parse','--git-dir'])",
     'missing runtime protection'],
    ['node -e "const c=require','node bin/aws-emulator-mcp.mjs config copilot',
     'unguarded node execution'],
    ['can automatically download/build','cannot build','optional signed build warning'],
    ['not yet a published update','is already public','preview disclaimer missing'],
  ];
  for(const [needle,replacement,expected] of cases){
    assert.ok(html.includes(needle),'missing test fixture '+needle);
    const errors=inspect(html.replace(needle,replacement));
    assert.ok(errors.some(e=>e.includes(expected)),JSON.stringify({expected,errors}));
  }
});
test('failed clone with preexisting directory never executes old code',()=>{
  const root=mkdtempSync(join(tmpdir(),'goal-clone-fail-'));
  try{
    const f=fixture(root,'api');
    const clone=exec('git',['clone',f.directory,f.directory],root);
    assert.notEqual(clone.status,0,'Clone must fail for existing destination');
    const result=exec(process.execPath,['-e',guardScript(snippets().get('goal-api-run').code)],root);
    assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,/Refusing unverified checkout/);
    assert.equal(existsSync(f.marker),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('stale checkout refuses every route, including opt-in Docker probe',()=>{
  const root=mkdtempSync(join(tmpdir(),'goal-stale-'));
  try{
    const fixtures=names.map(goal=>fixture(root,goal));
    for(const [key,item] of snippets()){
      if(!key.endsWith('-run') && !key.endsWith('-probe'))continue;
      const result=exec('sh',['-c',item.code],root);
      assert.equal(result.status,2,key+': '+result.stderr);
      assert.match(result.stderr,/Refusing unverified checkout/);
    }
    for(const f of fixtures)assert.equal(existsSync(f.marker),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('matching commit alone is insufficient: modified source never executes',()=>{
  const root=mkdtempSync(join(tmpdir(),'goal-dirty-'));
  try{
    const f=fixture(root,'api');
    const runner=guardScript(snippets().get('goal-api-run').code).replace(R3_SHA,f.sha);
    writeFileSync(join(f.directory,'bin/aws-emulator-mcp.mjs'),
      "import{writeFileSync}from'node:fs';import{resolve}from'node:path';writeFileSync(resolve('..','executed-api.marker'),'dirty');\n");
    const result=exec(process.execPath,['-e',runner],root);
    assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,/Refusing unverified checkout/);
    assert.equal(existsSync(f.marker),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('missing clone directory fails closed before any repository source is opened',()=>{
  const root=mkdtempSync(join(tmpdir(),'goal-missing-'));
  try{
    for(const [key,item] of snippets()){
      if(!key.endsWith('-run') && !key.endsWith('-probe'))continue;
      const result=exec(process.execPath,['-e',guardScript(item.code)],root);
      assert.equal(result.status,2,key+': '+result.stderr);
      assert.match(result.stderr,/Refusing unverified checkout/);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('guard permits only a clean, matching controlled local test fixture',()=>{
  const root=mkdtempSync(join(tmpdir(),'goal-verified-'));
  try{
    const f=fixture(root,'api');
    const runner=guardScript(snippets().get('goal-api-run').code).replace(R3_SHA,f.sha);
    const result=exec(process.execPath,['-e',runner],root);
    assert.equal(result.status,0,result.stderr);
    assert.equal(existsSync(f.marker),true,'only intentionally verified test fixture executes');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('preview links are version-scoped and never claim public Explorer launch',()=>{
  const s=section();
  assert.ok(!s.includes('https://b11-health.github.io/aws-emulator-mcp/proof-explorer.html'));
  assert.match(s,/blob\/release\/agent-team-preview-r3-20261118\/docs\/GUIDED_APP_PROOF\.md/);
  assert.match(s,/blob\/release\/agent-team-preview-r3-20261118\/docs\/COVERAGE\.md/);
  assert.match(s,/blob\/v0\.4\.0-beta\.15\/docs\/ARCHITECTURE_STUDIO\.md/);
  assert.match(readme,/not yet deployed/);
  assert.match(readme,/No emulator API response alone establishes AWS production parity/);
});
test('safe configuration CLI is implemented and does not need Docker',()=>{
  const r=exec(process.execPath,['bin/aws-emulator-mcp.mjs','config','copilot'],ROOT);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/"mcpServers"/);
});
