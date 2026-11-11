import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function filesUnder(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    else throw new Error(`Unsupported release filesystem entry: ${path}`);
  }
  return files.sort();
}

const digest = content => createHash('sha256').update(content).digest('hex');

export async function verifyStaticManifest({rootDirectory, manifestFile}) {
  const root = resolve(rootDirectory);
  const manifest = JSON.parse(await readFile(resolve(manifestFile), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Unsupported static manifest schema.');
  const expectedPaths = manifest.files.map(file => file.path);
  if (new Set(expectedPaths).size !== expectedPaths.length || expectedPaths.some(path => typeof path !== 'string' || !/^(?:index\.html|styles\.css|dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js)$/u.test(path))) throw new Error('Manifest contains an unsafe or duplicate public path.');
  if (JSON.stringify([...expectedPaths].sort()) !== JSON.stringify(expectedPaths)) throw new Error('Manifest paths must be sorted.');
  const actualPaths = await filesUnder(root);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error('Release file set does not match the manifest.');
  for (const expected of manifest.files) {
    const content = await readFile(resolve(root, expected.path));
    if (content.byteLength !== expected.bytes || digest(content) !== expected.sha256) throw new Error(`Release digest mismatch: ${expected.path}`);
  }
  const releaseSha256 = digest(manifest.files.map(file => `${file.path}\0${file.sha256}\n`).join(''));
  if (releaseSha256 !== manifest.releaseSha256) throw new Error('Release aggregate digest does not match the manifest.');
  return manifest.releaseSha256;
}

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (process.argv[index + 1] === undefined) throw new Error(`${name} requires a path.`);
  return process.argv[index + 1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const releaseSha256 = await verifyStaticManifest({
    rootDirectory: argumentValue('--root', resolve(projectRoot, 'release', 'site')),
    manifestFile: argumentValue('--manifest', resolve(projectRoot, 'release', 'forge-v0.1-beta-manifest.json')),
  });
  process.stdout.write(`Verified static release sha256 ${releaseSha256}\n`);
}
