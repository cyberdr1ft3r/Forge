import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildStaticSite, extractModuleSpecifiers} from '../scripts/build-static.mjs';
import {verifyStaticManifest} from '../scripts/verify-static-manifest.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function filesUnder(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, path));
    else files.push(relative(root, path).replaceAll('\\', '/'));
  }
  return files.sort();
}

test('static package contains only allowlisted browser assets and their module closure', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'forge-static-package-'));
  const output = resolve(temporary, 'site');
  try {
    const manifest = await buildStaticSite({outputDirectory: output});
    const files = await filesUnder(output);
    assert.deepEqual(files, manifest.files.map(file => file.path));
    assert.ok(files.includes('index.html'));
    assert.ok(files.includes('styles.css'));
    assert.ok(files.includes('dist/app.js'));
    assert.ok(files.every(path => /^(?:index\.html|styles\.css|dist\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js)$/u.test(path)), files.join('\n'));
    assert.ok(files.every(path => !/(?:^|\/)(?:src|tests|docs|scripts|ops|node_modules|\.git)(?:\/|$)/u.test(path)));
    assert.ok(files.every(path => !/\.(?:map|ts|tsx|md|json|lock|ya?ml)$/u.test(path)));

    for (const path of files.filter(path => path.endsWith('.js'))) {
      const source = await readFile(resolve(output, path), 'utf8');
      assert.doesNotMatch(source, /sourceMappingURL/u, `${path} references an excluded source map`);
      for (const specifier of extractModuleSpecifiers(source)) {
        assert.ok(specifier.startsWith('.'), `${path} has non-relative import ${specifier}`);
        const dependency = resolve(dirname(resolve(output, path)), specifier);
        assert.ok(files.includes(relative(output, dependency).replaceAll('\\', '/')), `${path} is missing ${specifier}`);
      }
    }
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
});

test('two clean static builds produce byte-equivalent assets and manifests', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'forge-static-reproducibility-'));
  const first = resolve(temporary, 'first');
  const second = resolve(temporary, 'second');
  try {
    const firstManifest = await buildStaticSite({outputDirectory: first});
    const secondManifest = await buildStaticSite({outputDirectory: second});
    assert.deepEqual(firstManifest, secondManifest);
    for (const file of firstManifest.files) {
      assert.deepEqual(await readFile(resolve(first, file.path)), await readFile(resolve(second, file.path)), file.path);
    }
    const manifestPath = resolve(temporary, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(firstManifest), 'utf8');
    assert.equal(await verifyStaticManifest({rootDirectory: first, manifestFile: manifestPath}), firstManifest.releaseSha256);
    await writeFile(resolve(first, '.env'), 'SECRET=not-real\n', 'utf8');
    await assert.rejects(verifyStaticManifest({rootDirectory: first, manifestFile: manifestPath}), /file set does not match/u);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
});

test('Nginx template allowlists routes and applies an explicit restrictive CSP', async () => {
  const template = await readFile(resolve(projectRoot, 'ops/nginx/forge-beta.conf.template'), 'utf8');
  for (const route of ['/', '/generators/nginx', '/generators/compose', '/generators/systemd']) {
    assert.match(template, new RegExp(`location = ${route.replaceAll('/', '\\/') === '' ? '\\/' : route.replaceAll('/', '\\/')}`));
  }
  assert.match(template, /location \/ \{ return 404; \}/u);
  assert.match(template, /default-src 'none'/u);
  assert.match(template, /script-src 'self'/u);
  assert.match(template, /object-src 'none'/u);
  assert.match(template, /frame-ancestors 'none'/u);
  assert.match(template, /Strict-Transport-Security/u);
  assert.doesNotMatch(template, /example\.com|\/var\/www\/html/u);
});

test('Nginx template renderer accepts bounded settings and rejects directive injection', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'forge-nginx-render-'));
  const output = resolve(temporary, 'forge.conf');
  const environment = {
    ...process.env,
    FORGE_HTTP_PORT: '8080',
    FORGE_HTTPS_PORT: '8443',
    FORGE_SERVER_NAME: 'localhost',
    FORGE_RELEASE_ROOT: '/srv/forge/current',
    FORGE_TLS_CERTIFICATE: '/etc/nginx/tls/fullchain.pem',
    FORGE_TLS_KEY: '/etc/nginx/tls/privkey.pem',
    FORGE_PUBLIC_ORIGIN: 'https://localhost:8443',
  };
  try {
    const valid = spawnSync(process.execPath, ['scripts/render-nginx-template.mjs', '--output', output], {cwd: projectRoot, env: environment, encoding: 'utf8'});
    assert.equal(valid.status, 0, valid.stderr);
    const rendered = await readFile(output, 'utf8');
    assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/u);
    assert.match(rendered, /root \/srv\/forge\/current;/u);

    const invalid = spawnSync(process.execPath, ['scripts/render-nginx-template.mjs', '--output', resolve(temporary, 'unsafe.conf')], {
      cwd: projectRoot,
      env: {...environment, FORGE_SERVER_NAME: 'localhost; include /tmp/unsafe.conf'},
      encoding: 'utf8',
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /FORGE_SERVER_NAME is invalid/u);
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
});
