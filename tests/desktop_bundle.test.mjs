import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT,'packaging','claude-desktop','manifest.json')));
const pkg = JSON.parse(readFileSync(path.join(ROOT,'package.json')));

test('MCPB entrypoint is an existing bundled local Node launcher', () => {
  assert.equal(manifest.manifest_version,'0.3');
  assert.equal(manifest.name,'aws-emulator-mcp');
  assert.equal(manifest.version,pkg.version);
  assert.equal(manifest.server.type,'node');
  assert.equal(manifest.server.entry_point,'bin/aws-emulator-mcp.mjs');
  assert.ok(existsSync(path.join(ROOT,manifest.server.entry_point)));
  const config=manifest.server.mcp_config;
  assert.equal(config.command,'node');
  assert.deepEqual(config.args,['$'+'{__dirname}/bin/aws-emulator-mcp.mjs','mcp']);
  assert.equal(config.env,undefined);
});

test('MCPB does not suggest credentials, remote AWS or host-wide permissions', () => {
  const text=JSON.stringify(manifest);
  assert.doesNotMatch(text,/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|DOCKER_HOST|--privileged|--network host|http:\/\//);
  assert.ok(manifest.description.includes('Independent'));
  assert.match(text,/Docker/i);
  assert.deepEqual(manifest.compatibility.platforms,['win32','darwin']);
});

test('new Copilot config is native and generated from local Node path', () => {
  const result=spawnSync(process.execPath,['bin/aws-emulator-mcp.mjs','config','copilot'],{
    cwd:ROOT,encoding:'utf8',timeout:15000
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stderr,'');
  const obj=JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(obj),['mcpServers']);
  const c=obj.mcpServers['aws-emulator-local'];
  assert.equal(c.type,'stdio');
  assert.equal(c.command,process.execPath);
  assert.equal(c.args.length,2);
  assert.equal(c.args[1],'mcp');
  assert.ok(existsSync(c.args[0]));
});

test('legacy VS Code format has an explicit nonblocking deprecation warning', () => {
  const result=spawnSync(process.execPath,['bin/aws-emulator-mcp.mjs','config','vscode'],{
    cwd:ROOT,encoding:'utf8',timeout:15000
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).servers['aws-emulator-local'].type,'stdio');
  assert.match(result.stderr,/deprecated editor-managed/);
  assert.doesNotMatch(result.stdout,/deprecated/);
});

test('desktop install guidance distinguishes current and legacy clients', () => {
  const doc=readFileSync(path.join(ROOT,'docs','DESKTOP_INSTALL.md'),'utf8');
  for (const needed of [
    'config copilot','config vscode','Claude Desktop','unsigned',
    'Docker','Linux-container','independent','not an AWS product'
  ])assert.match(doc,new RegExp(needed,'i'));
  assert.ok(doc.includes('code.visualstudio.com/docs/agents/reference/mcp-configuration'));
  assert.ok(doc.includes('support.claude.com/en/articles/10949351'));
});
