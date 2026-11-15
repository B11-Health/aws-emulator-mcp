#!/usr/bin/env node
/**
 * GitHub-native Architecture Studio review.
 * Compares two strictly validated local blueprint manifests. No AWS SDK,
 * AWS credentials, Docker, outbound network, arbitrary PR code or live
 * CloudFormation change-set calls. NEVER report this as an AWS change set.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  realpathSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ArchitectureError, generateDrawio, generateSvg, generateTemplate,
  generateYaml, readManifest, validateArchitecture
} from './architecture_studio.mjs';

const LIMIT = 24 * 1024;
const MODES = ['unchanged', 'added', 'modified', 'removed', 'conceptual'];
const SERVICE = {
  's3-bucket': 'S3', 'dynamodb-table': 'DynamoDB', 'sqs-queue': 'SQS'
};
const COLORS = {
  unchanged: ['#eef2f6', '#475569'],
  added: ['#d7f4e4', '#136c43'],
  modified: ['#fff1d4', '#976315'],
  removed: ['#ffe2e0', '#b42332'],
  conceptual: ['#e4edff', '#315da6']
};
const ESCAPE = s => String(s).replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'
})[char]);
const SHA = t => createHash('sha256').update(t).digest('hex');
const json = o => JSON.stringify(o, null, 2) + '\n';
const stable = o => JSON.stringify(o);
const bad = msg => { throw new ArchitectureError(msg); };

function equal(a,b) { return stable(a) === stable(b); }

function pathsOk(relative) {
  if (typeof relative !== 'string' || relative.length < 2 ||
      relative.length > 180 || !/^[A-Za-z0-9_./-]+$/.test(relative) ||
      relative.startsWith('/') || relative.split('/').some(
        x => !x || x === '.' || x === '..' ||
          ['.git','.ssh','node_modules'].includes(x))) {
    bad('Paths must be safe workspace-relative paths');
  }
  return relative;
}

function outputPath(workspace, relative) {
  pathsOk(relative);
  const root = realpathSync(workspace);
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) bad('Output path escapes workspace');
  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink())
        bad('Symlinked architecture output paths are not allowed');
      if (current !== target && !lstatSync(current).isDirectory())
        bad('Architecture output has non-directory parent');
    }
  }
  if (existsSync(target) && !lstatSync(target).isDirectory())
    bad('Architecture evidence output must be a directory');
  return target;
}

const pathFixture = (manifest, id) =>
  manifest?.flows.find(f => f.to === id)?.label || '';

/** Each change is strictly a blueprint comparison, NOT an AWS change set. */
export function compareArchitecture(beforeInput, afterInput) {
  const before = beforeInput === null ? null : validateArchitecture(beforeInput);
  const after = validateArchitecture(afterInput);
  const beforeCFN = before ? generateTemplate(before) : null;
  const afterCFN = generateTemplate(after);
  const a = new Map(after.resources.map(v => [v.id, v]));
  const b = new Map((before?.resources || []).map(v => [v.id, v]));
  const ids = [...new Set([...b.keys(), ...a.keys()])].sort((x,y)=>x.localeCompare(y));
  const changes = ids.map(id => {
    const old = b.get(id);
    const next = a.get(id);
    if (!old) return {
      id, status: 'added', risk: 'low',
      typeBefore: null, typeAfter: next.type,
      reason: 'New resource in proposed blueprint'
    };
    if (!next) return {
      id, status: 'removed', risk: 'high',
      typeBefore: old.type, typeAfter: null,
      reason: old.type === 'sqs-queue' ?
        'Queue removed from template; potential message loss if a real update were applied' :
        'Resource removed from template; Retain may leave unmanaged billable data'
    };
    const cfnDifferent = !equal(beforeCFN.Resources[id], afterCFN.Resources[id]);
    const diagramDifferent = old.label !== next.label ||
      pathFixture(before, id) !== pathFixture(after, id) ||
      before.actor.label !== after.actor.label ||
      before.actor.id !== after.actor.id;
    if (!cfnDifferent && !diagramDifferent) return {
      id, status: 'unchanged', risk: 'none',
      typeBefore: old.type, typeAfter: next.type,
      reason: 'Resource definition and conceptual flow unchanged'
    };
    if (!cfnDifferent) return {
      id, status: 'conceptual', risk: 'none',
      typeBefore: old.type, typeAfter: next.type,
      reason: 'Diagram text/flow only; generated CloudFormation resource unchanged'
    };
    const typeChanged = old.type !== next.type;
    const keyChanged = old.type === 'dynamodb-table' && next.type === 'dynamodb-table' &&
      old.partitionKey !== next.partitionKey;
    return {
      id, status: 'modified', risk: typeChanged || keyChanged ? 'high' : 'review',
      typeBefore: old.type, typeAfter: next.type,
      reason: typeChanged ? 'Resource type changed: potential replacement; verify with real AWS change set' :
        keyChanged ? 'DynamoDB partition key changed: potential replacement; verify before deployment' :
          'CloudFormation properties changed; impact unknown without a real change set'
    };
  });
  if (changes.length > 6) bad('Architecture review has too many changed resource identities');
  const counts = Object.fromEntries(MODES.map(status => [
    status, changes.filter(c => c.status === status).length
  ]));
  const high = changes.filter(c => c.risk === 'high').length;
  const conceptualFlowsChanged = !equal(before?.flows || [], after.flows) ||
    !equal(before?.actor || null, after.actor);
  return {
    schemaVersion: 1, reviewKind: 'local-blueprint-comparison',
    name: after.name, beforePresent: before !== null,
    awsAccountAccess: false, cloudFormationChangeSet: false,
    awsDeployment: false, emulatorTestExecuted: false,
    beforeSha256: before ? SHA(json(before)) : null,
    afterSha256: SHA(json(after)),
    counts, highRiskCount: high, conceptualFlowsChanged,
    changes, warnings: [
      'This is a source-manifest comparison, NOT an AWS CloudFormation change set or actual deployment plan.',
      'High-risk flags are conservative prompts for human review, not proof that AWS will replace or delete a resource.',
      'The actor and arrows show conceptual flow. No application, IAM role, permissions, event binding or integration is deployed.',
      'Use a real AWS CloudFormation change set, security review and cost review before approving any deployment.'
    ]
  };
}

function sideSvg(manifest, statuses, x, heading) {
  const s = [
    '<g transform="translate(' + x + ',110)">',
    '<rect x="0" y="0" width="572" height="458" rx="17" fill="#ffffff" stroke="#cbd5e1"/>',
    '<text x="24" y="35" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="#1d3c54">' + ESCAPE(heading) + '</text>',
    '<text x="24" y="58" font-family="Arial,sans-serif" font-size="12" fill="#64748b">Conceptual connections; physical resources only in CloudFormation</text>'
  ];
  if (!manifest) {
    s.push('<text x="66" y="246" font-family="Arial,sans-serif" font-size="21" fill="#64748b">No baseline manifest in the base commit</text></g>');
    return s.join('\n');
  }
  const actorDisplay = manifest.actor.label.replace(/\s*\(conceptual\)\s*$/i,'');
  const shortActor = actorDisplay.length>21 ? actorDisplay.slice(0,20)+'…' : actorDisplay;
  s.push('<rect x="24" y="197" width="170" height="60" rx="11" fill="#153e58"/>',
    '<text x="37" y="225" font-family="Arial,sans-serif" font-size="13" font-weight="600" fill="#ffffff">' + ESCAPE(shortActor) + '</text>',
    '<text x="37" y="244" font-family="Arial,sans-serif" font-size="10" fill="#b7e0ff">Conceptual · not deployed</text>');
  const locations = {
    's3-bucket': 105, 'dynamodb-table': 223, 'sqs-queue': 341
  };
  for (const r of manifest.resources) {
    const y = locations[r.type];
    const status = statuses.get(r.id) || 'unchanged';
    const [fill, stroke] = COLORS[status];
    const flow = manifest.flows.find(f => f.to === r.id);
    const mid = y + 43;
    s.push(
      '<path d="M194 227 C235 227 222 ' + mid + ' 275 ' + mid +
        '" stroke="#8093a6" fill="none" stroke-width="2"/>',
      '<text x="206" y="' + (mid - 8) + '" font-family="Arial,sans-serif" font-size="10" fill="#526b80">' + ESCAPE(flow.label) + '</text>',
      '<rect data-node-id="' + ESCAPE(r.id) + '" data-status="' + status +
        '" x="275" y="' + y + '" width="272" height="86" rx="11" fill="' + fill +
        '" stroke="' + stroke + '" stroke-width="2"/>',
      '<text x="291" y="' + (y+25) + '" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="' + stroke + '">' +
        ESCAPE(SERVICE[r.type]) + ' · ' + ESCAPE(status.toUpperCase()) + '</text>',
      '<text x="291" y="' + (y+49) + '" font-family="Arial,sans-serif" font-size="15" font-weight="600" fill="#19364d">' +
        ESCAPE(r.label) + '</text>',
      '<text x="291" y="' + (y+68) + '" font-family="Arial,sans-serif" font-size="12" fill="#526b80">' +
        ESCAPE(r.id + (r.type === 'dynamodb-table' ? ' · key ' + r.partitionKey : '')) + '</text>'
    );
  }
  s.push('</g>');
  return s.join('\n');
}

export function generateDiffSvg(before, after, report) {
  const prev = before ? validateArchitecture(before) : null;
  const next = validateArchitecture(after);
  const statesBefore = new Map(report.changes.map(c => [c.id,c.status]));
  const statesAfter = new Map(report.changes.map(c => [c.id,c.status]));
  const sum = report.counts;
  const output = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="650" viewBox="0 0 1200 650" role="img" aria-label="AWS local blueprint comparison">',
    '<title>AWS architecture before and after · ' + ESCAPE(next.name) + '</title>',
    '<desc>Static comparison of proposed architecture manifests, not AWS change-set output or a deployment.</desc>',
    '<rect width="1200" height="650" rx="18" fill="#f3f7fb"/>',
    '<text x="27" y="46" font-family="Arial,sans-serif" font-size="25" font-weight="700" fill="#153e58">Architecture review · ' + ESCAPE(next.name) + '</text>',
    '<text x="27" y="74" font-family="Arial,sans-serif" font-size="14" fill="#465c70">' +
      sum.added + ' added · ' + sum.modified + ' modified · ' + sum.removed + ' removed · ' +
      report.highRiskCount + ' high-risk flags</text>',
    sideSvg(prev,statesBefore,24,'BASE'),
    sideSvg(next,statesAfter,607,'PROPOSED'),
    '<text x="28" y="603" font-family="Arial,sans-serif" font-size="13" font-weight="600" fill="#b42332">Review flags are NOT predicted CloudFormation actions.</text>',
    '<text x="28" y="624" font-family="Arial,sans-serif" font-size="12" fill="#526b80">No AWS account queried · no change set created · no infrastructure deployed</text>',
    '</svg>'
  ];
  return output.join('\n') + '\n';
}

export function markdownSummary(report) {
  const rows = report.changes.map(row =>
    '| `' + row.id + '` | ' + row.status + ' | ' + row.risk +
    ' | ' + row.reason.replace(/\|/g,'/') + ' |'
  );
  return [
    '### AWS Emulator MCP · proposed architecture review', '',
    '**Local blueprint diff only — not an AWS CloudFormation change set.**',
    '',
    '**' + report.counts.added + ' added · ' + report.counts.modified + ' modified · ' +
      report.counts.removed + ' removed · ' + report.highRiskCount + ' high-risk review flags**',
    '',
    '| Logical ID | Manifest status | Review priority | Why it matters |',
    '| :-- | :-- | :-- | :-- |', ...rows, '',
    'Download the **aws-emulator-architecture-review** artifact for the before/after diagram,',
    'CloudFormation template drafts, editable draw.io diagrams and JSON evidence.',
    '',
    'This job did **not** access AWS, create a change set, run the emulator, validate IAM, or deploy.',
    'Only a separate, explicitly approved AWS change-set review can determine real account impact.', ''
  ].join('\n');
}

function emptyBaselineSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="440" viewBox="0 0 900 440" role="img" aria-label="No baseline architecture">',
    '<title>No baseline blueprint</title>',
    '<rect width="900" height="440" rx="16" fill="#f5f8fb"/>',
    '<text x="65" y="210" font-family="Arial,sans-serif" font-size="24" fill="#526b80">No architecture manifest in base commit</text>',
    '<text x="65" y="246" font-family="Arial,sans-serif" font-size="16" fill="#526b80">All proposed resources are additions in this source-level review.</text>',
    '</svg>', ''
  ].join('\n');
}
function emptyBaselineDrawio() {
  return [
    '<mxfile host="app.diagrams.net" agent="AWS Emulator MCP Architecture Review" type="device">',
    '<diagram id="base" name="No baseline"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>',
    '</mxfile>', ''
  ].join('\n');
}

function safeWrite(workspace, output, files) {
  const directory = outputPath(workspace, output);
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(directory, name);
    if (existsSync(file) && (lstatSync(file).isSymbolicLink() ||
        !lstatSync(file).isFile() || readFileSync(file,'utf8') !== value)) {
      bad('Refusing to overwrite architecture review evidence');
    }
  }
  mkdirSync(directory,{recursive:true});
  for (const [name,value] of Object.entries(files)) {
    const file=path.join(directory,name);
    if (!existsSync(file)) writeFileSync(file,value,{flag:'wx',encoding:'utf8'});
  }
  return path.relative(realpathSync(workspace),directory).replace(/\\/g,'/');
}

export function writeReview(before, after, workspace, output='reports/architecture-review') {
  const b=before===null?null:validateArchitecture(before);
  const a=validateArchitecture(after);
  const report=compareArchitecture(b,a);
  const docs={
    'before-architecture.json': b===null ? json({baseline:'not-present'}) : json(b),
    'after-architecture.json': json(a),
    'before-diagram.svg': b===null ? emptyBaselineSvg() : generateSvg(b),
    'after-diagram.svg': generateSvg(a),
    'before-diagram.drawio': b===null ? emptyBaselineDrawio() : generateDrawio(b),
    'after-diagram.drawio': generateDrawio(a),
    'before-template.yaml': b===null ? '# No baseline manifest\n' : generateYaml(generateTemplate(b)),
    'after-template.yaml': generateYaml(generateTemplate(a)),
    'architecture-diff.svg': generateDiffSvg(b,a,report),
    'summary.md': markdownSummary(report)
  };
  report.artifacts=Object.fromEntries(Object.entries(docs).map(([name,value])=>[
    name,{sha256:SHA(value),bytes:Buffer.byteLength(value)}
  ]));
  docs['report.json']=json(report);
  const directory=safeWrite(workspace,output,docs);
  return { ...report, outputDirectory:directory, fileCount:Object.keys(docs).length };
}

function parseGitBase(workspace, sha, relative) {
  if (!/^[a-fA-F0-9]{40}$/.test(sha||'')) bad('Missing or invalid trusted base commit SHA');
  pathsOk(relative);
  const git=(args,maxBuffer=LIMIT*3)=>spawnSync('git',args,{
    cwd:workspace,encoding:'utf8',shell:false,windowsHide:true,
    timeout:8000,maxBuffer,stdio:['ignore','pipe','pipe']
  });
  const c=git(['cat-file','-t',sha]);
  if (c.status!==0 || c.stdout.trim()!=='commit')
    bad('Base commit not present in checkout; use fetch-depth 0');
  const spec=sha+':'+relative;
  const check=git(['cat-file','-e',spec]);
  if (check.status!==0) return null; // file added in PR; no previous manifest
  const cat=git(['show','--no-textconv',spec]);
  if (cat.status!==0 || Buffer.byteLength(cat.stdout)>LIMIT)
    bad('Base architecture manifest cannot be safely read');
  let parsed;
  try {parsed=JSON.parse(cat.stdout);}
  catch {bad('Base architecture manifest is not valid JSON');}
  return validateArchitecture(parsed);
}

export function githubReview({
  workspace, manifestPath='.aws-emulator/architecture.json',
  beforePath='', baseSha='', output='reports/architecture-review',
  summaryPath='', failOnRisk='never'
}) {
  if (!['never','high'].includes(failOnRisk))
    bad('Review policy must be never or high');
  const current=readManifest(workspace,pathsOk(manifestPath));
  const before=beforePath ? readManifest(workspace,pathsOk(beforePath)) :
    parseGitBase(workspace,baseSha,pathsOk(manifestPath));
  const report=writeReview(before,current,workspace,output);
  if (summaryPath) appendFileSync(summaryPath,markdownSummary(report),'utf8');
  return {report,failed:failOnRisk==='high' && report.highRiskCount>0};
}

function main() {
  const args=process.argv.slice(2);
  if (args[0]==='--github') {
    if (args.length!==1) bad('Architecture review CI only accepts --github');
    const workspace=process.env.GITHUB_WORKSPACE||process.cwd();
    const result=githubReview({
      workspace,
      manifestPath:process.env.AWS_MCP_REVIEW_MANIFEST||'.aws-emulator/architecture.json',
      beforePath:process.env.AWS_MCP_REVIEW_BEFORE||'',
      baseSha:process.env.AWS_MCP_REVIEW_BASE_SHA||'',
      output:process.env.AWS_MCP_REVIEW_OUTPUT||'reports/architecture-review',
      summaryPath:process.env.GITHUB_STEP_SUMMARY||'',
      failOnRisk:process.env.AWS_MCP_REVIEW_POLICY||'never'
    });
    console.log('Local blueprint review: '+result.report.changes.length+
      ' resource identities, '+result.report.highRiskCount+
      ' high-risk review flags; AWS was not contacted.');
    if (result.failed) process.exitCode=2;
    return;
  }
  const wantsJson=args.includes('--json');
  const strict=args.includes('--fail-on-risk');
  const rest=args.filter(a=>a!=='--json' && a!=='--fail-on-risk');
  if (args.filter(a=>a==='--json').length>1 ||
      args.filter(a=>a==='--fail-on-risk').length>1 ||
      rest.length<2 || rest.length>3)
    bad('Usage: architecture review <before.json> <after.json> [output-dir] [--json] [--fail-on-risk]');
  const b=readManifest(process.cwd(),pathsOk(rest[0]));
  const a=readManifest(process.cwd(),pathsOk(rest[1]));
  const report=writeReview(b,a,process.cwd(),rest[2]);
  if (wantsJson) console.log(json(report).trimEnd());
  else console.log(markdownSummary(report)+'\nFiles in '+report.outputDirectory);
  if (strict && report.highRiskCount>0) process.exitCode=2;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { main(); }
  catch(e) {
    console.error(e instanceof ArchitectureError ?
      'Architecture review: '+e.message :
      'Architecture review: unable to safely compare blueprint inputs');
    process.exitCode=1;
  }
}
