import {createHash} from 'node:crypto';
import {access, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = resolve(projectRoot, 'release', 'site');
const defaultManifest = resolve(projectRoot, 'release', 'forge-v0.1-beta-manifest.json');
const requiredPublicFiles = ['index.html', 'styles.css'];
const forbiddenPublicExtensions = new Set(['.map', '.ts', '.tsx', '.d.ts']);

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function extractModuleSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[1] !== undefined) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

async function collectJavaScript(entryFile) {
  const distRoot = resolve(projectRoot, 'dist');
  const pending = [entryFile];
  const files = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || files.has(current)) continue;
    if (!inside(distRoot, current) && current !== resolve(distRoot, 'app.js')) throw new Error(`JavaScript escaped dist/: ${current}`);
    if (extname(current) !== '.js') throw new Error(`Only compiled JavaScript may be packaged: ${current}`);
    await access(current);
    files.add(current);
    const source = await readFile(current, 'utf8');
    for (const specifier of extractModuleSpecifiers(source)) {
      if (!specifier.startsWith('.')) throw new Error(`Browser module uses a non-relative import: ${specifier}`);
      const dependency = resolve(dirname(current), specifier);
      if (!inside(distRoot, dependency)) throw new Error(`Browser import escaped dist/: ${specifier}`);
      pending.push(dependency);
    }
  }
  return [...files].sort();
}

async function listFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    else throw new Error(`Unsupported release filesystem entry: ${path}`);
  }
  return files.sort();
}

async function copyPublicFile(source, destinationRoot, publicPath) {
  const target = resolve(destinationRoot, publicPath);
  if (!inside(destinationRoot, target)) throw new Error(`Public path escaped the release root: ${publicPath}`);
  await mkdir(dirname(target), {recursive: true});
  const content = await readFile(source, 'utf8');
  await writeFile(target, content.replace(/\r\n?/gu, '\n'), 'utf8');
}

async function copyCompiledModule(source, destinationRoot) {
  const publicPath = relative(projectRoot, source);
  const target = resolve(destinationRoot, publicPath);
  if (!inside(destinationRoot, target)) throw new Error(`Compiled module escaped the release root: ${publicPath}`);
  const compiled = (await readFile(source, 'utf8')).replace(/\r\n?/gu, '\n');
  const withoutSourceMapReference = compiled.replace(/\n?\/\/# sourceMappingURL=.*\n?$/u, '\n');
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, withoutSourceMapReference, 'utf8');
}

export async function buildStaticSite({outputDirectory = defaultOutput, manifestFile} = {}) {
  const output = resolve(outputDirectory);
  if (output === projectRoot || dirname(output) === output) {
    throw new Error(`Refusing unsafe release output path: ${output}`);
  }
  if (output === defaultOutput) await rm(output, {recursive: true, force: true});
  else {
    try { await stat(output); throw new Error(`Custom output directory already exists: ${output}`); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  await mkdir(output, {recursive: true});

  for (const publicFile of requiredPublicFiles) await copyPublicFile(resolve(projectRoot, publicFile), output, publicFile);
  const html = await readFile(resolve(projectRoot, 'index.html'), 'utf8');
  const stylesheetSources = [...html.matchAll(/<link\b[^>]*\brel=['"]stylesheet['"][^>]*\bhref=['"]([^'"]+)['"][^>]*>/giu)].map(match => match[1]);
  if (stylesheetSources.length !== 1 || stylesheetSources[0] !== '/styles.css') throw new Error('index.html must load exactly /styles.css.');
  const css = await readFile(resolve(projectRoot, 'styles.css'), 'utf8');
  const cssResources = [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/giu)].map(match => match[2]).filter(value => value !== undefined && !value.startsWith('data:'));
  if (cssResources.length > 0) throw new Error(`styles.css contains unpackaged resources: ${cssResources.join(', ')}`);
  const scriptSources = [...html.matchAll(/<script\b[^>]*\bsrc=['"]([^'"]+)['"][^>]*>/giu)].map(match => match[1]);
  if (scriptSources.length !== 1 || scriptSources[0] !== '/dist/app.js') throw new Error('index.html must load exactly /dist/app.js.');
  for (const source of await collectJavaScript(resolve(projectRoot, scriptSources[0].slice(1)))) {
    await copyCompiledModule(source, output);
  }

  const publicFiles = await listFiles(output);
  for (const path of publicFiles) {
    if (path.startsWith('.') || path.split('/').some(part => part.startsWith('.'))) throw new Error(`Hidden file entered release: ${path}`);
    if (forbiddenPublicExtensions.has(extname(path)) || path.endsWith('.d.ts')) throw new Error(`Development file entered release: ${path}`);
  }
  const files = [];
  for (const path of publicFiles) {
    const content = await readFile(resolve(output, path));
    files.push({path, bytes: content.byteLength, sha256: sha256(content)});
  }
  const releaseSha256 = sha256(files.map(file => `${file.path}\0${file.sha256}\n`).join(''));
  const manifest = {schemaVersion: 1, release: 'forge-v0.1-beta', releaseSha256, files};
  if (manifestFile !== undefined) {
    const manifestPath = resolve(manifestFile);
    if (manifestPath === output || inside(output, manifestPath)) throw new Error('The release manifest must remain outside the public root.');
    await mkdir(dirname(manifestPath), {recursive: true});
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return manifest;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputDirectory = argumentValue('--output') ?? defaultOutput;
  const manifestFile = argumentValue('--manifest') ?? (resolve(outputDirectory) === defaultOutput ? defaultManifest : undefined);
  const manifest = await buildStaticSite({outputDirectory, manifestFile});
  process.stdout.write(`Static release: ${manifest.files.length} files, sha256 ${manifest.releaseSha256}\n`);
}
