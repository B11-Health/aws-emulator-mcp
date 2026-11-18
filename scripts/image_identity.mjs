/** Deterministic fingerprint of only files copied into the Docker runtime.
 * This is a local cache-coherency check, NOT authenticity or AWS parity proof.
 */
import { createHash } from 'node:crypto';
import { readdirSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SINGLE_FILES = [
  'docker/Dockerfile', 'docker/entrypoint.sh', 'scripts/install_wsl.sh'
];
const COPIED_DIRS = [
  'src/aws_emulator_mcp', 'examples/order-intake', 'examples/contracts', 'examples/reliability-lab'
];
const SKIP_DIR = new Set(['__pycache__']);
const SKIP_SUFFIX = /(?:\.pyc|\.pyo|\.log|\.mp4)$/i;

function copiedFiles(rootDir) {
  const output = [...SINGLE_FILES];
  for (const base of COPIED_DIRS) {
    const walk = relative => {
      const target = path.join(rootDir, relative);
      if (!lstatSync(target).isDirectory()) throw Error('Missing bundled Docker directory');
      for (const entry of readdirSync(target, {withFileTypes: true})) {
        if (SKIP_DIR.has(entry.name)) continue;
        const nested = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
        if (entry.isSymbolicLink()) throw Error('Symlink in Docker source is not allowed');
        if (entry.isDirectory()) walk(nested);
        else if (entry.isFile() && !SKIP_SUFFIX.test(entry.name)) output.push(nested);
        else if (!entry.isFile()) throw Error('Unexpected Docker source entry');
      }
    };
    walk(base);
  }
  return output.sort();
}

export function imageSourceDigest(rootDir = root) {
  const names = copiedFiles(rootDir);
  if (names.length < 6 || names.length > 256) throw Error('Unexpected source file count');
  const hash = createHash('sha256');
  hash.update('aws-emulator-mcp-local-image-cache/v1\0');
  let total = 0;
  for (const name of names) {
    const full = path.join(rootDir, ...name.split('/'));
    const info = lstatSync(full);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
      throw Error('Unsafe or missing Docker source file');
    total += info.size;
    if (total > 16 * 1024 * 1024) throw Error('Unexpected Docker source size');
    const bytes = readFileSync(full);
    hash.update(name + '\0' + bytes.length + '\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(imageSourceDigest() + '\n');
}
