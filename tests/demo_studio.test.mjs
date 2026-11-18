import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(ROOT, 'docs');
const read = rel => readFileSync(path.join(docs, rel),'utf8');

test('demo hub has six accessible scenario tabs, main landmark, video and captions',()=>{
 const html=read('index.html');
 assert.match(html,/id="main"/);
 assert.match(html,/role="tablist"/);
 assert.equal((html.match(/data-mission="[0-5]"/g)||[]).length,6);
 assert.match(html,/role="tabpanel"/);
 assert.match(html,/proof-first-beta15\.mp4/);
 assert.match(html,/https:\/\/b11-health\.github\.io\/aws-emulator-mcp\//);
 assert.match(html,/property="og:image"/);
 assert.match(html,/kind="captions"[^>]*srclang="en"/);
 assert.match(html,/limitations|Not a production outage|does not execute AWS APIs/i);
 assert.ok(existsSync(path.join(docs,'.nojekyll')));
});
test('all local first-party HTML references resolve within docs',()=>{
 const html=read('index.html');
 const paths=[...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(x=>x[1])
   .filter(x=>!x.startsWith('#')&&!/^https?:/.test(x));
 for(const link of paths){
   const p=path.resolve(docs,link);
   assert.ok(p.startsWith(docs+path.sep),'Outside docs: '+link);
   assert.ok(existsSync(p),'Missing local link: '+link);
 }
});
test('linked local evidence records executed success and expected missing Docker',()=>{
 const offline=JSON.parse(read('evidence/showcase-offline-trial-beta15.json'));
 assert.equal(offline.command,'node bin/aws-emulator-mcp.mjs try --json');
 assert.equal(offline.exitCode,0);
 assert.equal(offline.result.passed,true);
 assert.equal(offline.result.artifactCount,7);
 assert.equal(offline.result.syntheticContractSteps,14);
 assert.equal(offline.result.dockerUsed,false);
 assert.equal(offline.result.cloudCallsMade,false);
 const readiness=JSON.parse(read('evidence/showcase-no-docker-preflight-beta15.json'));
 assert.equal(readiness.exitCode,1);
 assert.equal(readiness.result.architectureReady,true);
 assert.equal(readiness.result.emulatorReady,false);
});
test('runtime CLI still reproduces the seven-artifact offline proof',()=>{
 const run=spawnSync(process.execPath,['bin/aws-emulator-mcp.mjs','try','--json'],{
   cwd:ROOT,encoding:'utf8',timeout:20000,
   env:{...process.env,DOCKER_HOST:'tcp://198.51.100.1:2375'}
 });
 assert.equal(run.status,0,run.stderr);
 const current=JSON.parse(run.stdout);
 const saved=JSON.parse(read('evidence/showcase-offline-trial-beta15.json')).result;
 assert.equal(current.sourceSha256,saved.sourceSha256);
 assert.equal(current.artifactCount,saved.artifactCount);
 assert.equal(current.syntheticContractSteps,14);
});
test('educational video is valid MP4 and carries separate captions and transcript',()=>{
 const file=path.join(docs,'assets/demos/proof-first-beta15.mp4');
 const bytes=readFileSync(file);
 assert.ok(bytes.length>500000 && bytes.length<30000000);
 assert.equal(bytes.subarray(4,8).toString('ascii'),'ftyp');
 assert.ok(statSync(path.join(docs,'assets/demos/proof-first-beta15-poster.jpg')).size>3000);
 assert.ok(statSync(path.join(docs,'assets/demos/proof-first-beta15-preview.gif')).size>3000);
 const vtt=read('assets/demos/proof-first-beta15.vtt');
 assert.match(vtt,/^WEBVTT\s/);
 assert.ok((vtt.match(/-->/g)||[]).length>=16);
 const transcript=read('SHOWCASE_TRANSCRIPT.md');
 assert.ok((transcript.match(/## Scene \d/g)||[]).length===8);
 assert.match(transcript,/not an uncut recording|not a live|not a continuous/i);
});
test('four narrated microdemos are linked and contain valid MP4 headers',()=>{
 const html=read('index.html');
 for (const name of ['quickstart','reliability','source-review','connect-agent']){
   const clip='assets/demos/beta15-'+name+'-demo.mp4';
   const poster='assets/demos/beta15-'+name+'-poster.jpg';
   assert.ok(html.includes(clip));
   const bytes=readFileSync(path.join(docs,clip));
   assert.ok(bytes.length>70000 && bytes.length<15000000);
   assert.equal(bytes.subarray(4,8).toString('ascii'),'ftyp');
   assert.ok(statSync(path.join(docs,poster)).size>3000);
 }
});
test('mission scripts are first-party and expose scope warnings, not simulated API calls',()=>{
 const js=read('demo-studio.js');
 assert.match(js,/const missions = \[/);
 assert.equal((js.match(/\{tag:'/g)||[]).length,6);
 for(const command of ['try --json','app-debug compare --json',
  'failure-lab partial-compare --json','app-compare examples/byo-order-handler/',
  'architecture review examples/architecture/review/','config copilot']){
  assert.ok(js.includes(command),'Missing documented command '+command);
 }
 assert.ok(js.includes('not a network-connected AWS emulator'));
 assert.ok(!js.includes('fetch('),'Demo hub should not make network API calls');
});


test('client install guide has three keyboard-accessible paths with correct limitations',()=>{
 const html=read('index.html');
 const js=read('demo-studio.js');
 const css=read('demo-studio.css');
 assert.equal((html.match(/data-client="[0-2]"/g)||[]).length,3);
 for(let i=0;i<3;i++){
  assert.match(html,new RegExp('id="client-tab-'+i+'"[^>]*role="tab"'));
  assert.match(html,new RegExp('role="tabpanel" id="client-panel-'+i+'"'));
  assert.match(html,new RegExp('aria-controls="client-panel-'+i+'"'));
 }
 assert.match(html,/config copilot/);
 assert.match(html,/mcpServers/);
 assert.match(html,/UNSIGNED/);
 assert.match(html,/SHA256SUMS/);
 assert.match(html,/local Docker/i);
 assert.match(html,/not yet verified/i);
 assert.match(html,/does not validate production IAM/i);
 assert.match(html,/href="https:\/\/github\.com\/B11-Health\/aws-emulator-mcp\/actions\/workflows\/desktop-bundle\.yml"/);
 assert.match(js,/function selectClient\(/);
 assert.match(js,/client-panel-/);
 assert.match(js,/ArrowRight/);
 assert.match(css,/\[hidden\]\{display:none!important\}/);
 assert.doesNotMatch(js,/fetch\(/);
});


test('public FAQ answers real adoption questions without suggesting AWS or IAM parity',()=>{
 const html=read('index.html');
 const section=html.split('<section class="section wrap" id="faq">')[1];
 assert.ok(section, 'FAQ missing');
 const faq=section.split('</section>')[0];
 assert.equal((faq.match(/<details>/g)||[]).length,4);
 assert.equal((faq.match(/<summary>/g)||[]).length,4);
 for(const fragment of [
  'Does this replace AWS or validate IAM permissions?',
  'Can Claude Code, Copilot, or other coding agents use it?',
  'Will this run on a normal laptop?',
  'Why use an MCP adapter instead of the native AWS SDK?',
  'not yet been verified',
  'not Docker Desktop VM capacity measurements',
  'immutable beta.15 tag',
  'not enough',
  'Use the native SDK/CLI when it is simpler',
 ])assert.ok(faq.includes(fragment),'Missing caveat or question: '+fragment);
 assert.match(faq,/independent 18-service report/);
 assert.match(faq,/1\.0\.322/);
 assert.match(faq,/href="#connect"/);
 assert.match(faq,/href="#install"/);
 assert.match(html,/href="#faq">FAQ/);
});


test('newcomer contribution paths are public, scoped, and require no push or AWS keys',()=>{
 const guide=readFileSync(path.join(ROOT,'CONTRIBUTING.md'),'utf8');
 const readme=readFileSync(path.join(ROOT,'README.md'),'utf8');
 const form=readFileSync(path.join(ROOT,'.github','ISSUE_TEMPLATE','independent_first_run.yml'),'utf8');
 const html=read('index.html');
 for(const n of [7,8,50,51,52])
   assert.ok(guide.includes('/issues/'+n),'missing newcomer issue #'+n);
 assert.match(guide,/do not need a collaborator invitation/i);
 assert.match(guide,/Fork/);
 assert.match(guide,/npm test/);
 assert.match(guide,/PYTHONPATH=src/);
 assert.match(guide,/not.*AWS APIs/i);
 assert.match(readme,/CONTRIBUTING\.md/);
 assert.match(readme,/independent_first_run\.yml/);
 assert.match(html,/blob\/master\/CONTRIBUTING\.md/);
 assert.match(form,/operating-system/);
 assert.match(form,/test-path/);
 assert.match(form,/Commands and observed outcomes/);
 assert.match(form,/credentials, private paths, account identifiers/);
 assert.match(form,/configuration-only results separately from actual MCP tool calls/);
 assert.doesNotMatch(form,/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|personal access token input/i);
});


test('community conduct and support policies route issues and protect private reports',()=>{
 const rootRead=rel=>readFileSync(path.join(ROOT,rel),'utf8');
 const coc=rootRead('CODE_OF_CONDUCT.md');
 const support=rootRead('SUPPORT.md');
 const security=rootRead('SECURITY.md');
 const readme=rootRead('README.md');
 const contribute=rootRead('CONTRIBUTING.md');
 const chooser=rootRead('.github/ISSUE_TEMPLATE/config.yml');
 for(const text of [coc,support,security,chooser])
  assert.ok(text.includes('https://github.com/B11-Health/aws-emulator-mcp/security/advisories'));
 for(const text of [coc,support,security])
  assert.match(text,/not|never|do not/i);
 assert.match(coc,/Harassment|harassment/i);
 assert.match(coc,/Report abuse/i);
 assert.match(coc,/independent open-source/i);
 assert.match(support,/Independent first-run report/i);
 assert.match(support,/Upstream AWS Emulator issues/i);
 assert.match(support,/Code of Conduct/i);
 assert.match(support,/cannot guarantee response/i);
 assert.match(security,/Private vulnerability reporting is enabled/);
 assert.match(security,/public issue or pull request/i);
 assert.match(readme,/SUPPORT\.md/);
 assert.match(contribute,/CODE_OF_CONDUCT\.md/);
 assert.match(contribute,/SUPPORT\.md/);
 assert.match(chooser,/Private vulnerability disclosure/);
 assert.match(chooser,/Help with setup and contribution routes/);
 assert.doesNotMatch(coc+support+security,/security@b11-health|support@b11-health/i);
});


test('public community hub routes newcomers to real scoped issues without inflated adoption claims',()=>{
 const html=read('index.html');
 const section=html.split('<section class="section wrap" id="community"')[1];
 assert.ok(section,'community landmark missing');
 const hub=section.split('</section>')[0];
 assert.equal((hub.match(/class="community-task"/g)||[]).length,4);
 for(const issue of [7,50,51,52])assert.match(hub,new RegExp('issues/'+issue+'(?:["/])'));
 assert.match(hub,/issues\/8/);
 assert.match(hub,/Results are still pending/);
 assert.match(hub,/Early participation, not proven adoption/);
 assert.match(hub,/direct repository write access is required/i);
 assert.match(hub,/independent_first_run\.yml/);
 assert.match(hub,/CONTRIBUTING\.md/);
 assert.match(html,/href="#community">Community/);
 assert.match(readFileSync(path.join(ROOT,'README.md'),'utf8'),/aws-emulator-mcp\/#community/);
 assert.doesNotMatch(hub,/thousands of users|AWS-certified|enterprise ready|official AWS extension/i);
});
