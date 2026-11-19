import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT,'docs/index.html'),'utf8');
const css = readFileSync(join(ROOT,'docs/demo-studio.css'),'utf8');
const js = readFileSync(join(ROOT,'docs/demo-studio.js'),'utf8');
const readme = readFileSync(join(ROOT,'README.md'),'utf8');
const cli = readFileSync(join(ROOT,'bin/aws-emulator-mcp.mjs'),'utf8');
const server = readFileSync(join(ROOT,'src/aws_emulator_mcp/server.py'),'utf8');

const ids = ['goal-api','goal-app','goal-architecture','goal-gaps'];
const scripts = ['goal-api-commands','goal-app-commands','goal-architecture-commands',
                 'goal-gaps-preflight','goal-gaps-probe'];
const R3 = 'release/agent-team-preview-r3-20261118';
const BETA = 'v0.4.0-beta.15';
const repo = 'https://github.com/B11-Health/aws-emulator-mcp.git';

function extract(htmlText = html) {
  const start = htmlText.indexOf('<section class="section wrap goal-router"');
  const end = htmlText.indexOf('<section class="section wrap app-proof"', start);
  return start < 0 || end < 0 ? '' : htmlText.slice(start,end);
}
function goal(id, source = html) {
  const segment = extract(source);
  const pattern = new RegExp('<details class="goal-card" id="'+id+'" name="developer-goal"(?: open)?>[\\s\\S]*?<\\/details>');
  return segment.match(pattern)?.[0] ?? '';
}
function commands(section = extract()) {
  const result = new Map();
  for (const match of section.matchAll(/<pre id="([^"]+)" tabindex="0"><code>([^<]+)<\/code><\/pre><button class="copy-button" type="button" data-copy="([^"]+)">([^<]+)<\/button>/g)) {
    result.set(match[1],{code:match[2].trim(),copyId:match[3],text:match[4]});
  }
  return result;
}
function checkMarkup(source = html) {
  const problems=[];
  const section=extract(source);
  if (!section) return ['No goal chooser in preview HTML'];
  if (!/<section[^>]*id="goals" aria-labelledby="goals-heading"/.test(section) || !/<h2 id="goals-heading">/.test(section))
    problems.push('Missing labeled section heading');
  if (!section.includes('not yet a published update')) problems.push('Missing unpublished-preview warning');
  if (/https:\/\/b11-health\.github\.io\/aws-emulator-mcp\/(?:#goals|goals)/.test(section))
    problems.push('Cannot link to an unpublished public goal chooser');
  if (/\b(?:fetch\(|sendBeacon|XMLHttpRequest|google-analytics|gtag\(|dataLayer\.push)/i.test(section))
    problems.push('Unexpected telemetry or network script');
  for (const id of ids) {
    const card=goal(id,source);
    if (!card || !/<summary>[\s\S]*?<\/summary>/.test(card)) problems.push('Missing native accessible disclosure: '+id);
    if (!/<p class="goal-next"><strong>Next:<\/strong>/.test(card)) problems.push('Missing one explicit next step: '+id);
    if (!card.includes('No AWS account') && !card.includes('no Docker or AWS account')) problems.push('Missing no-account scope: '+id);
  }
  const all=commands(section);
  for(const id of scripts){
    const item=all.get(id);
    if (!item || item.copyId !== id) {problems.push('Missing matching copy button: '+id);continue;}
    const lines=item.code.split(/\r?\n/);
    if(lines.some(line=>!line || line.includes('&&') || line.includes(';') || /\\\s*$/.test(line) || /^\s*(?:\$|>)\s/.test(line)))
      problems.push('Nonportable or chained command: '+id);
    if(lines.some(line=>!/^(?:git clone --depth 1 --branch \S+ https:\/\/github.com\/B11-Health\/aws-emulator-mcp\.git [a-z0-9-]+|cd [a-z0-9-]+|node bin\/aws-emulator-mcp\.mjs [a-z-]+(?: .+)?)$/.test(line)))
      problems.push('Not a portable implemented CLI command: '+id);
  }
  const expected=new Map([
    ['goal-api-commands', {branch:R3, tail:'node bin/aws-emulator-mcp.mjs config copilot'}],
    ['goal-app-commands', {branch:R3, tail:'node bin/aws-emulator-mcp.mjs app-guide examples/app-case/s3-upload.py --json'}],
    ['goal-architecture-commands', {branch:BETA, tail:'node bin/aws-emulator-mcp.mjs architecture demo'}],
    ['goal-gaps-preflight', {branch:R3, tail:'node bin/aws-emulator-mcp.mjs preflight --json'}],
    ['goal-gaps-probe', {branch:null, tail:'node bin/aws-emulator-mcp.mjs coverage s3 --json'}],
  ]);
  for (const [id, spec] of expected) {
    const command=all.get(id)?.code || '';
    const tail=command.split(/\r?\n/).at(-1);
    if(tail!==spec.tail) problems.push('Wrong or unimplemented command: '+id);
    if(spec.branch){
      const first=command.split(/\r?\n/)[0];
      if(!first.startsWith('git clone --depth 1 --branch '+spec.branch+' '+repo+' ')) problems.push('Wrong branch/tag: '+id);
    }
  }
  if (!goal('goal-api',source).includes('aws_sdk_preview') || !goal('goal-api',source).includes('not in beta.15') ||
      !goal('goal-api',source).includes('does <strong>not</strong> validate'))
    problems.push('API shape route could misrepresent setup vs preview');
  if(!goal('goal-app',source).includes('does <strong>not</strong> test your application') ||
     !goal('goal-app',source).includes('non-runnable') || !goal('goal-app',source).includes('Docker is not a hostile-code sandbox'))
    problems.push('App inspection could be mistaken for independent app proof');
  if(!goal('goal-architecture',source).includes('not a deployed stack') ||
     !goal('goal-architecture',source).includes('No AWS account, Docker image'))
    problems.push('Offline architecture could be misrepresented as deployment');
  if(!goal('goal-gaps',source).includes('can automatically download/build') ||
     !goal('goal-gaps',source).includes('Review') ||
     !goal('goal-gaps',source).includes('not</strong> full service support'))
    problems.push('Gap probe could silently build or overclaim AWS parity');
  return problems;
}

test('four native details disclosures exist, with headings and meaningful controls even without JS',()=>{
  assert.deepEqual(checkMarkup(),[]);
  assert.equal((extract().match(/<details class="goal-card"/g)||[]).length,4);
  assert.equal((extract().match(/<summary>/g)||[]).length,4);
  assert.equal((extract().match(/<p class="goal-next"><strong>Next:<\/strong>/g)||[]).length,4);
  assert.equal((extract().match(/ name="developer-goal"/g)||[]).length,4);
  assert.equal((extract().match(/ name="developer-goal" open>/g)||[]).length,1);
  assert.match(css,/\.goal-card>summary:focus-visible/);
  assert.match(css,/@media\(max-width:850px\)\{\.goal-grid\{grid-template-columns:1fr\}/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(js,/document\.querySelectorAll\('\[data-copy\]'\)/);
  assert.doesNotMatch(js,/\bfetch\(|sendBeacon|XMLHttpRequest/);
});

test('all five commands are real, correctly versioned, individually copyable, Bash/PowerShell single-line',()=>{
  const shell=commands();
  assert.equal(shell.size,5);
  assert.deepEqual(checkMarkup(),[]);
  assert.match(cli,/if \(command === 'app-guide'\)/);
  assert.match(cli,/if \(command === 'architecture'\)/);
  assert.match(cli,/if \(command === 'coverage'\)/);
  assert.match(cli,/if \(command === 'preflight'\)/);
  assert.match(cli,/if \(command === 'config'\)/);
  assert.match(server,/spec\("aws_sdk_preview"/); // implemented MCP tool, NOT a standalone CLI command
  const source=goal('goal-api');
  assert.match(source,/read-only|before/);
  assert.match(readme,/Choose what you need to do \(round-four source preview\)/);
  assert.match(readme,/not yet deployed to the public GitHub Pages Demo Studio/);
  assert.match(readme,/release\/agent-team-preview-r3-20261118/);
  assert.match(readme,/v0\.4\.0-beta\.15/);
  assert.doesNotMatch(readme,/https:\/\/b11-health\.github\.io\/aws-emulator-mcp\/#goals/);
});

test('negative QA rejects wrong preview branches, fake CLI calls and nonportable continuations',()=>{
  const source=html;
  for (const [needle,replacement,wanted] of [
    ['--branch '+R3+' '+repo+' aws-mcp-api','--branch '+BETA+' '+repo+' aws-mcp-api','Wrong branch/tag'],
    ['mcp.mjs coverage s3 --json','mcp.mjs imaginary-ai-probe --json','Wrong or unimplemented command'],
    ['mcp.mjs architecture demo','mcp.mjs architecture demo \\\n--json','Nonportable or chained command'],
    ['data-copy="goal-app-commands"','data-copy="nothing"','Missing matching copy button'],
    ['can automatically download/build','does not need any image','Gap probe could silently build'],
    ['not yet a published update','available right now on Pages','Missing unpublished-preview warning'],
  ]){
    assert.ok(source.includes(needle),'test fixture missing: '+needle);
    const problems=checkMarkup(source.replace(needle,replacement));
    assert.ok(problems.some(p=>p.includes(wanted)),JSON.stringify({wanted,problems}));
  }
});

test('preview guide links are source-specific and no public page/Explorer launch is implied',()=>{
  const section=extract();
  assert.ok(!section.includes('https://b11-health.github.io/aws-emulator-mcp/proof-explorer.html'));
  assert.ok(!section.includes('https://b11-health.github.io/aws-emulator-mcp/#goals'));
  assert.match(section,/blob\/release\/agent-team-preview-r3-20261118\/docs\/GUIDED_APP_PROOF\.md/);
  assert.match(section,/blob\/v0\.4\.0-beta\.15\/docs\/ARCHITECTURE_STUDIO\.md/);
  assert.match(section,/blob\/release\/agent-team-preview-r3-20261118\/docs\/COVERAGE\.md/);
  assert.match(section,/https:\/\/docs\.aws\.amazon\.com\/emulator\/latest\/userguide\/check-project\.html/);
  assert.match(section,/issues\/new\?template=field_report\.yml/);
});

test('implemented offline commands actually parse or run without Docker',()=>{
  const help=spawnSync(process.execPath,['bin/aws-emulator-mcp.mjs','help'],
    {cwd:ROOT,encoding:'utf8',timeout:10000});
  assert.equal(help.status,0,help.stderr);
  for(const label of ['config [format]','app-guide APP.py','architecture demo|build|review',
                      'preflight [--json]','coverage [svc]']){
    assert.ok(help.stdout.includes(label),label);
  }
  const config=spawnSync(process.execPath,['bin/aws-emulator-mcp.mjs','config','copilot'],
    {cwd:ROOT,encoding:'utf8',timeout:10000,
     env:{...process.env,DOCKER_HOST:'tcp://198.51.100.1:2375'}});
  assert.equal(config.status,0,config.stderr);
  assert.match(config.stdout,/"mcpServers"/);
});
