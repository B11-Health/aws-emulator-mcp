/** Prove the packaged architecture generator works in a fresh ephemeral workspace.
 * No Docker, AWS account, network, secrets, source execution, or user-file edits.
 * Intentionally validates artifact integrity, not AWS resource fidelity.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeArchitecture } from './architecture_studio.mjs';

const ARTIFACTS = [
  'architecture.json', 'template.json', 'template.yaml',
  'diagram.svg', 'diagram.drawio', 'contract.json', 'report.json'
];
const EXPECTED_TYPES = [
  'AWS::S3::Bucket', 'AWS::DynamoDB::Table', 'AWS::SQS::Queue'
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validHex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function runOfflineTrial({
  createWorkspace = () => mkdtempSync(path.join(tmpdir(), 'aws-mcp-offline-')),
  generate = workspace => executeArchitecture(['demo'], workspace)
} = {}) {
  const workspace = createWorkspace();
  try {
    const produced = generate(workspace);
    if (produced?.json !== false || !produced.report ||
        produced.report.name !== 'order-intake' ||
        produced.report.validated?.manifest !== true ||
        produced.report.validated?.awsDeployment !== false ||
        produced.report.validated?.emulatorContractExecuted !== false ||
        produced.report.validated?.graphNodes !== 3 ||
        produced.report.validated?.conceptualFlows !== 3 ||
        !validHex(produced.report.sourceSha256) ||
        JSON.stringify([...produced.report.generatedFiles].sort()) !==
          JSON.stringify([...ARTIFACTS].sort())) {
      throw Error('Unexpected offline generator report');
    }
    const output = path.join(workspace, 'reports', 'architecture-studio');
    const files = {};
    for (const name of ARTIFACTS) {
      const file = path.join(output, name);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 ||
          stat.size > 256 * 1024) throw Error('Missing or unsafe artifact');
      const bytes = readFileSync(file);
      files[name] = bytes.toString('utf8');
      const declared = produced.report.artifacts?.[name];
      if (name !== 'report.json' &&
          (!declared || declared.bytes !== bytes.length ||
           !validHex(declared.sha256) || declared.sha256 !== digest(bytes))) {
        throw Error('Offline artifact checksum mismatch');
      }
    }
    const manifest = JSON.parse(files['architecture.json']);
    const template = JSON.parse(files['template.json']);
    const contract = JSON.parse(files['contract.json']);
    const report = JSON.parse(files['report.json']);
    const declared = Object.entries(template.Resources || {});
    const types = declared.map(([, resource]) => resource.Type).sort();
    const expected = [...EXPECTED_TYPES].sort();
    const reportTypes = (report.resources || []).map(r => r.cloudFormationType).sort();
    if (JSON.stringify(types) !== JSON.stringify(expected) ||
        JSON.stringify(reportTypes) !== JSON.stringify(expected) ||
        manifest.resources?.length !== 3 ||
        manifest.flows?.length !== 3 ||
        report.sourceSha256 !== produced.report.sourceSha256 ||
        contract.schemaVersion !== 1 || !Array.isArray(contract.steps) ||
        contract.steps.length < 10 || contract.steps.length > 16 ||
        !files['diagram.svg'].includes('<svg') ||
        !files['diagram.svg'].includes('</svg>') ||
        !files['diagram.drawio'].includes('<mxfile') ||
        files['template.yaml'].length < 100) {
      throw Error('Offline artifact structure mismatch');
    }
    return {
      schemaVersion: 1,
      passed: true,
      test: 'offline-architecture-generation',
      artifactCount: ARTIFACTS.length,
      resourceTypes: expected,
      syntheticContractSteps: contract.steps.length,
      sourceSha256: report.sourceSha256,
      dockerUsed: false,
      cloudCallsMade: false,
      generatedFilesPreserved: false,
      limitations: 'Proves the local architecture generator and artifact checksums, not AWS deployment, IAM, service fidelity or application behavior.',
      nextCommand: 'aws-emulator-mcp architecture demo',
      sourceCheckoutNextCommand: 'node bin/aws-emulator-mcp.mjs architecture demo',
    };
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
}

export function formatOfflineTrial(proof) {
  return [
    'AWS Emulator MCP / offline first-run check',
    `  ${proof.passed ? 'PASS' : 'FAIL'}  Architecture generator / 3 reviewed resource types`,
    `  Verified output artifacts: ${proof.artifactCount}`,
    `  Generated synthetic API contract: ${proof.syntheticContractSteps} steps (NOT executed)`,
    `  Manifest SHA-256: ${proof.sourceSha256}`,
    '  No Docker, AWS account, production credentials, or cloud requests.',
    '  Temporary artifacts verified and removed. To keep them:',
    '  From checkout: ' + proof.sourceCheckoutNextCommand,
    '  Installed CLI: ' + proof.nextCommand,
    '  This is not an AWS fidelity or security assessment.', ''
  ].join('\n');
}
