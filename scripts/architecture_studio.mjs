#!/usr/bin/env node
/**
 * Strict subset of an architecture-as-data compiler.
 * No AWS credentials, Docker, network, arbitrary template fragments or user code.
 * A single reviewed manifest produces CloudFormation, visual graph, and a
 * synthetic local AWS API contract. It does not deploy, import, or emulate
 * CloudFormation/IAM/application integrations.
 */
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'examples/architecture/order-intake.json');
const TYPES = ['s3-bucket', 'dynamodb-table', 'sqs-queue'];
const AWS = {
  's3-bucket': 'AWS::S3::Bucket',
  'dynamodb-table': 'AWS::DynamoDB::Table',
  'sqs-queue': 'AWS::SQS::Queue'
};
const SERVICE = {
  's3-bucket': 'S3',
  'dynamodb-table': 'DynamoDB',
  'sqs-queue': 'SQS'
};
const KIND_FILL = {
  's3-bucket': '#e8f1ff',
  'dynamodb-table': '#f4eaff',
  'sqs-queue': '#fff0dd'
};
const KIND_STROKE = {
  's3-bucket': '#3766ac',
  'dynamodb-table': '#7548ae',
  'sqs-queue': '#b86b20'
};
const GENERATED = [
  'architecture.json', 'template.json', 'template.yaml',
  'diagram.svg', 'diagram.drawio', 'contract.json', 'report.json'
];
const WARNINGS = [
  'The OrderApp actor and arrows are conceptual; CloudFormation does not deploy an application, IAM policy, trigger or resource-to-resource integration.',
  'The contract creates separate, synthetic emulator resources; it does not test a deployed CloudFormation stack.',
  'CloudFormation resource properties have not been validated by a live AWS account. Review with cfn-lint, IAM/security tools and a real change set before deploying.',
  'Actual AWS resources can incur charges; S3 and DynamoDB data-bearing resources have Retain deletion policies.'
];

export class ArchitectureError extends Error {
  constructor(message) { super(message); this.name = 'ArchitectureError'; }
}

const plain = v => v !== null && typeof v === 'object' &&
  !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const sameKeys = (v, required, allowed) => {
  if (!plain(v)) return false;
  const keys = Object.keys(v);
  return required.every(k => keys.includes(k)) &&
    keys.every(k => allowed.includes(k));
};
const sha = text => createHash('sha256').update(text).digest('hex');
const safeText = (text, limit = 96) =>
  typeof text === 'string' && text.length > 0 &&
  text.length <= limit && !/[\x00-\x1f\x7f]/.test(text) &&
  !/(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|(?:password|api[_ -]?key|secret|private[_ -]?key|token)\s*[:=]|https?:\/\//i.test(text);

function error(message) { throw new ArchitectureError(message); }

/** Validate full manifest before writes. Supported scope is intentionally narrow. */
export function validateArchitecture(value) {
  if (!sameKeys(value,
    ['schemaVersion', 'name', 'description', 'actor', 'resources', 'flows'],
    ['schemaVersion', 'name', 'description', 'actor', 'resources', 'flows'])) {
    error('Architecture requires only schemaVersion, name, description, actor, resources and flows');
  }
  if (value.schemaVersion !== 1 || !Number.isInteger(value.schemaVersion))
    error('Architecture schemaVersion must be 1');
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(value.name || ''))
    error('Architecture name must be a short lowercase slug');
  if (!safeText(value.description, 160)) error('Invalid or potentially sensitive architecture description');
  if (!sameKeys(value.actor, ['id', 'label'], ['id', 'label']) ||
      !/^[A-Z][A-Za-z0-9]{1,49}$/.test(value.actor.id || '') ||
      !safeText(value.actor.label, 30))
    error('Architecture actor needs a simple ID and safe label');
  if (!Array.isArray(value.resources) || !value.resources.length || value.resources.length > 3)
    error('Architecture supports 1-3 resources (one of each allowlisted service)');
  if (!Array.isArray(value.flows) || value.flows.length !== value.resources.length)
    error('Every resource must have exactly one conceptual actor-to-resource flow');

  const known = new Set([value.actor.id]);
  const kinds = new Set();
  for (const resource of value.resources) {
    if (!sameKeys(resource, ['id', 'type', 'label'], ['id', 'type', 'label', 'partitionKey']) ||
        !/^[A-Z][A-Za-z0-9]{1,49}$/.test(resource.id || '') ||
        !TYPES.includes(resource.type) || !safeText(resource.label, 30)) {
      error('Resource has invalid or unsupported ID, type, label, or properties');
    }
    if (known.has(resource.id) || kinds.has(resource.type))
      error('Resource logical IDs and AWS service types must be unique');
    known.add(resource.id);
    kinds.add(resource.type);
    if (resource.type === 'dynamodb-table') {
      if (typeof resource.partitionKey !== 'string' ||
          !/^[a-z][A-Za-z0-9]{0,31}$/.test(resource.partitionKey) ||
          resource.partitionKey === 'status')
        error('DynamoDB requires a simple explicit partitionKey');
    } else if ('partitionKey' in resource) {
      error('partitionKey applies only to DynamoDB');
    }
  }

  const seenTargets = new Set();
  for (const flow of value.flows) {
    if (!sameKeys(flow, ['from', 'to', 'label'], ['from', 'to', 'label']) ||
        flow.from !== value.actor.id || !known.has(flow.to) ||
        flow.to === value.actor.id || seenTargets.has(flow.to) ||
        !safeText(flow.label, 30)) {
      error('Flows must be unique, safe, conceptual actor-to-resource links');
    }
    seenTargets.add(flow.to);
  }
  // Canonicalizes presentation order without inventing resources.
  return {
    schemaVersion: 1, name: value.name, description: value.description,
    actor: { id: value.actor.id, label: value.actor.label },
    resources: TYPES.filter(type => kinds.has(type)).map(type => {
      const resource = value.resources.find(r => r.type === type);
      return {
        id: resource.id, type, label: resource.label,
        ...(type === 'dynamodb-table' ? { partitionKey: resource.partitionKey } : {})
      };
    }),
    flows: value.resources.slice().sort(
      (a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type)
    ).map(r => {
      const flow = value.flows.find(f => f.to === r.id);
      return { from: value.actor.id, to: r.id, label: flow.label };
    })
  };
}

function resourceDefinition(r) {
  if (r.type === 's3-bucket') {
    return {
      Type: AWS[r.type], DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true, BlockPublicPolicy: true,
          IgnorePublicAcls: true, RestrictPublicBuckets: true
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [{
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }
          }]
        },
        VersioningConfiguration: { Status: 'Enabled' }
      }
    };
  }
  if (r.type === 'dynamodb-table') {
    return {
      Type: AWS[r.type], DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
      Properties: {
        AttributeDefinitions: [{ AttributeName: r.partitionKey, AttributeType: 'S' }],
        KeySchema: [{ AttributeName: r.partitionKey, KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        SSESpecification: { SSEEnabled: true }
      }
    };
  }
  return {
    Type: AWS[r.type],
    Properties: { SqsManagedSseEnabled: true, VisibilityTimeout: 60 }
  };
}

function outputSuffix(type) {
  return {
    's3-bucket': 'Name', 'dynamodb-table': 'Name', 'sqs-queue': 'Url'
  }[type];
}
export function generateTemplate(manifest) {
  const resources = {};
  const outputs = {};
  for (const r of manifest.resources) {
    resources[r.id] = resourceDefinition(r);
    outputs[r.id + outputSuffix(r.type)] = {
      Description: 'CloudFormation-created ' + r.label,
      Value: { Ref: r.id }
    };
  }
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'Architecture Studio / ' + manifest.name +
      '. Resources only; conceptual actor and flows are NOT deployed.',
    Resources: resources, Outputs: outputs
  };
}

const quoteKey = k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k);
const yamlScalar = v =>
  typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
function yamlLines(value, indent = 0) {
  const space = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [space + '[]'];
    return value.flatMap(v => {
      if (!plain(v) && !Array.isArray(v)) return [space + '- ' + yamlScalar(v)];
      return [space + '-', ...yamlLines(v, indent + 2)];
    });
  }
  if (plain(value)) {
    if (!Object.keys(value).length) return [space + '{}'];
    return Object.entries(value).flatMap(([key, v]) => {
      if (!plain(v) && !Array.isArray(v)) {
        return [space + quoteKey(key) + ': ' + yamlScalar(v)];
      }
      return [space + quoteKey(key) + ':', ...yamlLines(v, indent + 2)];
    });
  }
  return [space + yamlScalar(value)];
}
export const generateYaml = template =>
  '# Generated AWS CloudFormation template. Review before real AWS deployment.\n' +
  yamlLines(template).join('\n') + '\n';

const xml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
})[char]);

function positions(manifest) {
  const ys = {
    1: [215], 2: [145, 305], 3: [85, 220, 355]
  }[manifest.resources.length];
  const nodes = manifest.resources.map((r, i) => ({
    ...r, x: 735, y: ys[i], w: 370, h: 95
  }));
  return {
    actor: { ...manifest.actor, x: 75, y: 220, w: 275, h: 90 },
    nodes
  };
}

/** One SVG source includes explicit semantic IDs for testable topology. */
export function generateSvg(manifest) {
  const { actor, nodes } = positions(manifest);
  const lines = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="560" viewBox="0 0 1200 560" role="img" aria-label="' +
      xml(manifest.name) + ' conceptual AWS architecture">',
    '<title>' + xml(manifest.name) + ' / AWS architecture</title>',
    '<desc>Conceptual actor and flows, with deployable CloudFormation S3, DynamoDB and SQS resources. No app, IAM or integration wiring is deployed.</desc>',
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="#506a81"/></marker></defs>',
    '<rect width="1200" height="560" rx="18" fill="#f8fafc"/>',
    '<text x="65" y="52" font-family="Arial,sans-serif" font-size="25" font-weight="700" fill="#16334d">' +
      xml(manifest.name) + '</text>',
    '<text x="65" y="80" font-family="Arial,sans-serif" font-size="14" fill="#53697d">Architecture blueprint · not a deployed application</text>',
    '<rect x="' + actor.x + '" y="' + actor.y + '" width="' + actor.w + '" height="' +
      actor.h + '" rx="15" fill="#153e58" stroke="#153e58" data-actor-id="' + xml(actor.id) + '"/>',
    '<text x="96" y="' + (actor.y + 38) + '" font-family="Arial,sans-serif" font-size="19" font-weight="700" fill="#fff">' +
      xml(actor.label) + '</text>',
    '<text x="96" y="' + (actor.y + 64) + '" font-family="Arial,sans-serif" font-size="12" fill="#c7e7ff">Conceptual · not deployed</text>'
  ];
  for (const r of nodes) {
    const flow = manifest.flows.find(f => f.to === r.id);
    const x1 = actor.x + actor.w, y1 = actor.y + actor.h / 2;
    const x2 = r.x, y2 = r.y + r.h / 2;
    const curve = 'M' + x1 + ' ' + y1 + ' C' + (x1 + 135) + ' ' + y1 + ' ' +
      (x2 - 150) + ' ' + y2 + ' ' + (x2 - 12) + ' ' + y2;
    lines.push(
      '<path data-flow="' + xml(flow.from + ':' + flow.to) +
        '" d="' + curve + '" fill="none" stroke="#506a81" stroke-width="2.2" marker-end="url(#arrow)"/>',
      '<text x="520" y="' + (Math.round((y1 + y2) / 2) - 12) +
        '" font-family="Arial,sans-serif" font-size="13" fill="#41596f">' +
        xml(flow.label) + '</text>',
      '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h +
        '" rx="14" fill="' + KIND_FILL[r.type] + '" stroke="' + KIND_STROKE[r.type] +
        '" stroke-width="2" data-resource-id="' + xml(r.id) + '" data-type="' + xml(r.type) + '"/>',
      '<text x="' + (r.x + 24) + '" y="' + (r.y + 32) +
        '" font-family="Arial,sans-serif" font-size="14" font-weight="700" fill="' +
        KIND_STROKE[r.type] + '">' + xml(SERVICE[r.type]) + '</text>',
      '<text x="' + (r.x + 24) + '" y="' + (r.y + 59) +
        '" font-family="Arial,sans-serif" font-size="19" font-weight="600" fill="#17334c">' +
        xml(r.label) + '</text>',
      '<text x="' + (r.x + 24) + '" y="' + (r.y + 79) +
        '" font-family="Arial,sans-serif" font-size="12" fill="#4d6475">' +
        xml(r.id) + ' · ' + xml(AWS[r.type]) + '</text>'
    );
  }
  lines.push(
    '<rect x="65" y="506" width="1070" height="36" rx="8" fill="#edf2f7"/>',
    '<text x="82" y="529" font-family="Arial,sans-serif" font-size="12" fill="#425a70">Solid boxes = CloudFormation resources · dark box and arrows = conceptual app flow, not implemented IAM or integrations</text>',
    '</svg>'
  );
  return lines.join('\n') + '\n';
}

export function generateDrawio(manifest) {
  const { actor, nodes } = positions(manifest);
  const parts = [
    '<mxfile host="app.diagrams.net" agent="AWS Emulator MCP Architecture Studio" type="device">',
    '<diagram id="architecture" name="Architecture">',
    '<mxGraphModel dx="1200" dy="560" grid="1" gridSize="10" guides="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="560">',
    '<root><mxCell id="0"/><mxCell id="1" parent="0"/>',
    '<mxCell id="actor-' + xml(actor.id) + '" value="' + xml(actor.label + ' (conceptual, not deployed)') +
      '" style="rounded=1;whiteSpace=wrap;html=0;fillColor=#153e58;strokeColor=#153e58;fontColor=#ffffff;fontSize=15;" vertex="1" parent="1">' +
      '<mxGeometry x="' + actor.x + '" y="' + actor.y + '" width="' + actor.w + '" height="' + actor.h + '" as="geometry"/></mxCell>'
  ];
  for (const r of nodes) {
    parts.push(
      '<mxCell id="resource-' + xml(r.id) + '" value="' +
        xml(r.label + ' / ' + AWS[r.type] + ' / ' + r.id) +
        '" style="rounded=1;whiteSpace=wrap;html=0;fillColor=' + KIND_FILL[r.type] +
        ';strokeColor=' + KIND_STROKE[r.type] +
        ';fontColor=#17334c;fontSize=15;" vertex="1" parent="1">' +
        '<mxGeometry x="' + r.x + '" y="' + r.y +
        '" width="' + r.w + '" height="' + r.h + '" as="geometry"/></mxCell>'
    );
  }
  for (const r of nodes) {
    const f = manifest.flows.find(x => x.to === r.id);
    parts.push(
      '<mxCell id="flow-' + xml(f.from + '-' + f.to) + '" value="' + xml(f.label + ' (conceptual)') +
      '" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=0;endArrow=block;endFill=1;strokeWidth=2;strokeColor=#506a81;"' +
      ' edge="1" parent="1" source="actor-' + xml(f.from) + '" target="resource-' + xml(f.to) +
      '"><mxGeometry relative="1" as="geometry"/></mxCell>'
    );
  }
  parts.push('</root></mxGraphModel></diagram></mxfile>');
  return parts.join('\n') + '\n';
}

/** Synthetic only: distinct emulator fixtures, NOT resources from CloudFormation. */
export function generateContract(manifest) {
  const steps = [];
  const includes = type => manifest.resources.some(r => r.type === type);
  const id = { '$fixture': 'id' };
  if (includes('s3-bucket')) {
    steps.push(
      { id: 's3create', service: 's3', operation: 'CreateBucket',
        parameters: { Bucket: { '$fixture': 'bucket' } } },
      { id: 's3put', service: 's3', operation: 'PutObject',
        parameters: { Bucket: { '$fixture': 'bucket' }, Key: 'receipt.txt', Body: 'demo' } },
      { id: 's3read', service: 's3', operation: 'GetObject',
        parameters: { Bucket: { '$fixture': 'bucket' }, Key: 'receipt.txt' },
        expect: { assertions: [{ path: 'ContentLength', equals: 4 }] } },
      { id: 's3delete', service: 's3', operation: 'DeleteObject',
        parameters: { Bucket: { '$fixture': 'bucket' }, Key: 'receipt.txt' } },
      { id: 's3remove', service: 's3', operation: 'DeleteBucket',
        parameters: { Bucket: { '$fixture': 'bucket' } } }
    );
  }
  if (includes('dynamodb-table')) {
    const partitionKey = manifest.resources.find(r => r.type === 'dynamodb-table').partitionKey;
    steps.push(
      { id: 'ddbcreate', service: 'dynamodb', operation: 'CreateTable',
        parameters: {
          TableName: { '$fixture': 'table' },
          AttributeDefinitions: [{ AttributeName: partitionKey, AttributeType: 'S' }],
          KeySchema: [{ AttributeName: partitionKey, KeyType: 'HASH' }],
          BillingMode: 'PAY_PER_REQUEST'
        } },
      { id: 'ddbput', service: 'dynamodb', operation: 'PutItem',
        parameters: {
          TableName: { '$fixture': 'table' },
          Item: { [partitionKey]: { S: id }, status: { S: 'received' } }
        } },
      { id: 'ddbget', service: 'dynamodb', operation: 'GetItem',
        parameters: {
          TableName: { '$fixture': 'table' },
          Key: { [partitionKey]: { S: id } }
        },
        expect: { assertions: [{ path: 'Item.status.S', equals: 'received' }] } },
      { id: 'ddbremove', service: 'dynamodb', operation: 'DeleteTable',
        parameters: { TableName: { '$fixture': 'table' } } }
    );
  }
  if (includes('sqs-queue')) {
    steps.push(
      { id: 'sqscreate', service: 'sqs', operation: 'CreateQueue',
        parameters: { QueueName: { '$fixture': 'queue' } },
        expect: { assertions: [{ path: 'QueueUrl', exists: true }] } },
      { id: 'sqssend', service: 'sqs', operation: 'SendMessage',
        parameters: { QueueUrl: { '$ref': 'sqscreate.QueueUrl' }, MessageBody: 'fulfillment-event' },
        expect: { assertions: [{ path: 'MessageId', exists: true }] } },
      { id: 'sqsreceive', service: 'sqs', operation: 'ReceiveMessage',
        parameters: { QueueUrl: { '$ref': 'sqscreate.QueueUrl' }, MaxNumberOfMessages: 1 },
        expect: { assertions: [{ path: 'Messages.0.Body', equals: 'fulfillment-event' }] } },
      { id: 'sqsack', service: 'sqs', operation: 'DeleteMessage',
        parameters: {
          QueueUrl: { '$ref': 'sqscreate.QueueUrl' },
          ReceiptHandle: { '$ref': 'sqsreceive.Messages.0.ReceiptHandle' }
        } },
      { id: 'sqsremove', service: 'sqs', operation: 'DeleteQueue',
        parameters: { QueueUrl: { '$ref': 'sqscreate.QueueUrl' } } }
    );
  }
  if (steps.length > 16) error('Generated contract exceeds 16-step safety bound');
  return { schemaVersion: 1, name: manifest.name + '-api-smoke', steps };
}

export function generateArchitecture(value) {
  const manifest = validateArchitecture(value);
  const cfn = generateTemplate(manifest);
  const payload = {
    'architecture.json': JSON.stringify(manifest, null, 2) + '\n',
    'template.json': JSON.stringify(cfn, null, 2) + '\n',
    'template.yaml': generateYaml(cfn),
    'diagram.svg': generateSvg(manifest),
    'diagram.drawio': generateDrawio(manifest),
    'contract.json': JSON.stringify(generateContract(manifest), null, 2) + '\n'
  };
  const resources = manifest.resources.map(r => ({
    id: r.id, type: r.type, cloudFormationType: AWS[r.type]
  }));
  const report = {
    schemaVersion: 1, name: manifest.name,
    validated: {
      manifest: true,
      cloudFormationSyntax: 'generated; not independently checked against AWS',
      awsDeployment: false, emulatorContractExecuted: false,
      graphNodes: manifest.resources.length, conceptualFlows: manifest.flows.length
    },
    resources, warnings: WARNINGS,
    sourceSha256: sha(payload['architecture.json']),
    artifacts: Object.fromEntries(Object.entries(payload).map(
      ([name, content]) => [name, { sha256: sha(content), bytes: Buffer.byteLength(content) }]
    ))
  };
  payload['report.json'] = JSON.stringify(report, null, 2) + '\n';
  return { manifest, template: cfn, contract: generateContract(manifest), files: payload, report };
}

function localPath(workspace, relative, { mustExist = false, file = false } = {}) {
  if (typeof relative !== 'string' || !relative.length || relative.length > 180 ||
      path.isAbsolute(relative) || !/^[A-Za-z0-9_./-]+$/.test(relative) ||
      relative.split(/[\\/]/).some(s => s === '' || s === '.' || s === '..') ||
      /^[A-Za-z]:/.test(relative)) error('Only bounded workspace-relative paths are allowed');
  if (relative.split('/').some(segment =>
    ['.git', '.ssh', 'node_modules'].includes(segment))) {
    error('Architecture paths cannot target repository metadata or dependencies');
  }
  const root = realpathSync(workspace);
  const resolved = path.resolve(root, relative);
  const portion = path.relative(root, resolved);
  if (!portion || portion.startsWith('..' + path.sep) || portion === '..' ||
      path.isAbsolute(portion)) error('Path escapes workspace');
  let current = root;
  const parts = portion.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    if (!existsSync(current)) {
      if (mustExist) error('Source manifest does not exist');
      if (i !== parts.length - 1) continue;
    } else {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) error('Symlinks are not allowed in architecture paths');
      if (i !== parts.length - 1 && !stat.isDirectory())
        error('Path component is not a directory');
      if (file && i === parts.length - 1 && !stat.isFile())
        error('Architecture manifest must be a regular file');
    }
  }
  return resolved;
}

export function readManifest(workspace, relative) {
  const filename = localPath(workspace, relative, { mustExist: true, file: true });
  const stat = lstatSync(filename);
  if (stat.size < 2 || stat.size > 24 * 1024)
    error('Manifest must be a bounded JSON file of at most 24 KiB');
  let parsed;
  try { parsed = JSON.parse(readFileSync(filename, 'utf8')); }
  catch { error('Architecture manifest is not valid JSON'); }
  return validateArchitecture(parsed);
}

export function writeArchitecture(value, workspace, output = 'reports/architecture-studio') {
  const built = generateArchitecture(value);
  const destination = localPath(workspace, output);
  if (existsSync(destination) && !lstatSync(destination).isDirectory())
    error('Output must be a directory');
  // Preflight all writes before touching the workspace. Idempotent identical
  // files are allowed; any conflict fails instead of overwriting user data.
  for (const [name, content] of Object.entries(built.files)) {
    const file = path.join(destination, name);
    if (existsSync(file)) {
      if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() ||
          readFileSync(file, 'utf8') !== content)
        error('Output conflict: refusing to overwrite ' + name);
    }
  }
  mkdirSync(destination, { recursive: true });
  for (const [name, content] of Object.entries(built.files)) {
    const file = path.join(destination, name);
    if (!existsSync(file)) writeFileSync(file, content, { flag: 'wx', encoding: 'utf8' });
  }
  return { ...built.report, outputDirectory: path.relative(realpathSync(workspace), destination),
    generatedFiles: GENERATED };
}

export function executeArchitecture(args, workspace = process.cwd()) {
  const json = args.includes('--json');
  const rest = args.filter(x => x !== '--json');
  if (args.filter(x => x === '--json').length > 1)
    error('Usage: architecture demo [output-dir] | build <manifest.json> [output-dir] [--json]');
  if (rest[0] === 'demo' && rest.length <= 2) {
    const manifest = JSON.parse(readFileSync(DEMO, 'utf8'));
    return { json, report: writeArchitecture(manifest, workspace, rest[1]) };
  }
  if (rest[0] === 'build' && rest.length >= 2 && rest.length <= 3) {
    const manifest = readManifest(workspace, rest[1]);
    return { json, report: writeArchitecture(manifest, workspace, rest[2]) };
  }
  error('Usage: architecture demo [output-dir] | build <manifest.json> [output-dir] [--json]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { json, report } = executeArchitecture(process.argv.slice(2));
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('Architecture Studio: ' + report.name);
      console.log('Generated ' + report.generatedFiles.length + ' files in ' + report.outputDirectory);
      console.log(report.resources.map(x => x.id + ': ' + x.cloudFormationType).join('\n'));
      console.log('Conceptual flows only. No AWS resources created or credentials used.');
      console.log('Review CloudFormation, security, cost and the local synthetic contract before any deployment.');
    }
  } catch (e) {
    console.error('Architecture Studio: ' + (
      e instanceof ArchitectureError ? e.message : 'Unable to generate safe architecture artifacts'));
    process.exitCode = 1;
  }
}
