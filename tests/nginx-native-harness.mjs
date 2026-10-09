import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {composeNginxCapabilities} from '../dist/nginx-composition/index.js';

const PROCESS_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const OFFICIAL_IMAGE = /^nginx:(\d+\.\d+\.\d+)(?:@sha256:[a-f0-9]{64})?$/;
const REQUIRED_MODULES = ['http_map', 'http_proxy', 'http_rewrite', 'http_ssl'];

function parseArguments(argv) {
  const result = {image: undefined, report: undefined};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--image') result.image = argv[++index];
    else if (value === '--report') result.report = argv[++index];
    else throw new Error(`Unsupported argument: ${value}`);
  }
  const match = typeof result.image === 'string' ? OFFICIAL_IMAGE.exec(result.image) : null;
  if (match === null) throw new Error('Pass a pinned official image as --image nginx:<major>.<minor>.<patch> with an optional sha256 digest.');
  if (typeof result.report !== 'string' || result.report.length === 0) throw new Error('Pass an explicit --report path.');
  return {image: result.image, expectedVersion: match[1], report: resolve(result.report)};
}

function boundedAppend(current, chunk) {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return `${current}${String(chunk)}`.slice(0, MAX_OUTPUT_BYTES);
}

function runProcess(command, args, {timeoutMs = PROCESS_TIMEOUT_MS} = {}) {
  return new Promise((resolveResult, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => { stdout = boundedAppend(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, chunk); });
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveResult({command, args, exitCode: code, signal, timedOut, stdout, stderr, durationMs: Date.now() - startedAt});
    });
  });
}

function dockerSecurityArguments() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('A numeric Linux UID/GID is required for isolated fixture access.');
  return [
    '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', `${uid}:${gid}`,
    '--read-only', '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--tmpfs', '/var/cache/nginx:rw,noexec,nosuid,size=16m',
    '--tmpfs', '/var/run:rw,noexec,nosuid,size=4m',
  ];
}

function requireSuccess(result, label) {
  assert.equal(result.timedOut, false, `${label} timed out`);
  assert.equal(result.exitCode, 0, `${label} failed\n${result.stderr}\n${result.stdout}`);
}

function compose(request, name) {
  const result = composeNginxCapabilities(request);
  assert.equal(result.ok, true, `${name} composition failed: ${JSON.stringify(result.diagnostics)}`);
  return result;
}

const proxy = {id: 'reverse-proxy', input: {domain: 'app.example.com', targetHost: '127.0.0.1', targetPort: 3000}};
const routing = {id: 'routing', input: {routes: [
  {prefix: '/api/', targetHost: '127.0.0.1', targetPort: 8080, forwarding: 'preserve-prefix'},
  {prefix: '/admin/', targetHost: '127.0.0.1', targetPort: 9000, forwarding: 'strip-prefix'},
]}};
const websocketRoot = {id: 'websocket', input: {routes: ['/']}};
const websocketRoutes = {id: 'websocket', input: {routes: ['/', '/api/']}};

function tls(redirectHttp) {
  return {id: 'tls', input: {
    certificatePath: '/fixtures/shared/cert.pem',
    privateKeyPath: '/fixtures/shared/key.pem',
    redirectHttp,
  }};
}

function compositionRequest(version, capabilities, profile = 'full-config') {
  return {profile, target: {version, modules: REQUIRED_MODULES}, capabilities};
}

async function materializePositive(root, version) {
  const definitions = [
    ['http-reverse-proxy', [proxy], 'full-config'],
    ['https-reverse-proxy', [proxy, tls(false)], 'full-config'],
    ['canonical-redirect', [proxy, tls(true)], 'full-config'],
    ['websocket-proxy', [proxy, websocketRoot], 'full-config'],
    ['tls-websocket', [proxy, websocketRoot, tls(false)], 'full-config'],
    ['multiple-literal-routes', [proxy, routing], 'full-config'],
    ['preserve-prefix', [proxy, {id: 'routing', input: {routes: [routing.input.routes[0]]}}], 'full-config'],
    ['strip-prefix', [proxy, {id: 'routing', input: {routes: [routing.input.routes[1]]}}], 'full-config'],
    ['full-config-artifact', [proxy, routing, websocketRoutes, tls(true)], 'full-config'],
    ['site-fragment-bundle', [proxy, routing, websocketRoutes, tls(false)], 'site-fragment'],
  ];
  const fixtures = [];
  for (const [name, capabilities, profile] of definitions) {
    const result = compose(compositionRequest(version, capabilities, profile), name);
    const fixture = await materializeComposition(root, name, result, profile);
    fixtures.push({...fixture, source: 'forge-composition-output'});
  }

  const ordered = compose(compositionRequest(version, [proxy, routing, websocketRoutes, tls(true)]), 'determinism-a');
  const reordered = compose(compositionRequest(version, [websocketRoutes, tls(true), routing, proxy]), 'determinism-b');
  assert.deepEqual(reordered.artifacts, ordered.artifacts, 'Equivalent selection orders must emit byte-identical artifacts');
  fixtures.push({...await materializeComposition(root, 'selection-order-determinism', ordered, 'full-config'), source: 'forge-composition-output', equivalentSelectionOrderVerified: true});
  return {fixtures, generated: new Map(fixtures.map(item => [item.name, item]))};
}

async function materializeComposition(root, name, result, profile) {
  const directory = join(root, name);
  await mkdir(directory, {recursive: true});
  for (const output of result.artifacts) await writeFile(join(directory, output.filename), output.content, {encoding: 'utf8', mode: 0o600});
  if (profile === 'site-fragment') {
    const wrapper = 'events {}\nhttp {\n  include /fixtures/site-fragment-bundle/http-shared.conf;\n  include /fixtures/site-fragment-bundle/site.conf;\n}\n';
    await writeFile(join(directory, 'nginx.conf'), wrapper, {encoding: 'utf8', mode: 0o600});
  }
  return {name, directory, config: join(directory, 'nginx.conf'), profile};
}

async function materializeNegative(root, generated) {
  const source = async name => readFile(generated.get(name).config, 'utf8');
  const mutations = [
    {
      name: 'invalid-directive-context', source: 'http-reverse-proxy',
      mutate: content => content.replace('location / {', 'location / {\n      map $http_upgrade $bad_context { default close; }'),
      expected: ['"map" directive is not allowed here'],
    },
    {
      name: 'duplicate-conflicting-declaration', source: 'http-reverse-proxy',
      mutate: content => content.replace('proxy_pass http://127.0.0.1:3000;', 'proxy_pass http://127.0.0.1:3000;\n      proxy_pass http://127.0.0.1:3001;'),
      expected: ['"proxy_pass" directive is duplicate'],
    },
    {
      name: 'malformed-directive-arguments', source: 'http-reverse-proxy',
      mutate: content => content.replace('proxy_pass http://127.0.0.1:3000;', 'proxy_pass;'),
      expected: ['invalid number of arguments in "proxy_pass" directive'],
    },
    {
      name: 'missing-tls-certificate', source: 'https-reverse-proxy',
      mutate: content => content.replace('/fixtures/shared/cert.pem', '/fixtures/shared/missing-cert.pem'),
      expected: ['cannot load certificate'],
    },
    {
      name: 'missing-tls-private-key', source: 'https-reverse-proxy',
      mutate: content => content.replace('/fixtures/shared/key.pem', '/fixtures/shared/missing-key.pem'),
      expected: ['cannot load certificate key'],
    },
    {
      name: 'unsupported-directive', source: 'http-reverse-proxy',
      mutate: content => content.replace('http {', 'http {\n  forge_missing_module_directive on;'),
      expected: ['unknown directive "forge_missing_module_directive"'],
    },
  ];
  const fixtures = [];
  for (const mutation of mutations) {
    const original = await source(mutation.source);
    const content = mutation.mutate(original);
    assert.notEqual(content, original, `${mutation.name} did not mutate its known-good Forge fixture`);
    fixtures.push(await writeNegative(root, mutation.name, content, mutation.source, mutation.expected));
  }

  const bundle = generated.get('site-fragment-bundle');
  const bundleShared = await readFile(join(bundle.directory, 'http-shared.conf'), 'utf8');
  const bundleSite = await readFile(join(bundle.directory, 'site.conf'), 'utf8');
  const invalidInclude = `include /fixtures/invalid-include-placement/http-shared.conf;\nevents {}\nhttp {\n  include /fixtures/invalid-include-placement/site.conf;\n}\n`;
  const includeFixture = await writeNegative(root, 'invalid-include-placement', invalidInclude, 'site-fragment-bundle', ['"map" directive is not allowed here']);
  await writeFile(join(includeFixture.directory, 'http-shared.conf'), bundleShared, {encoding: 'utf8', mode: 0o600});
  await writeFile(join(includeFixture.directory, 'site.conf'), bundleSite, {encoding: 'utf8', mode: 0o600});
  fixtures.push(includeFixture);
  fixtures.push(await writeNegative(root, 'invalid-site-fragment-assembly', bundleSite, 'site-fragment-bundle', ['"server" directive is not allowed here']));
  return fixtures;
}

async function writeNegative(root, name, content, sourceFixture, expected) {
  const directory = join(root, name);
  await mkdir(directory, {recursive: true});
  const config = join(directory, 'nginx.conf');
  await writeFile(config, content, {encoding: 'utf8', mode: 0o600});
  return {name, directory, config, profile: 'deliberately-invalid-mutation', source: `negative mutation of ${sourceFixture}`, expected};
}

function configureChecks(versionOutput, configureOutput, expectedVersion) {
  const combined = `${versionOutput}\n${configureOutput}`;
  const hasFlag = flag => new RegExp(`(?:^|\\s)${flag.replaceAll('-', '\\-')}(?:$|\\s)`, 'm').test(combined);
  const actual = /nginx version: nginx\/(\d+\.\d+\.\d+)/.exec(combined)?.[1];
  assert.equal(actual, expectedVersion, `Container tag/version mismatch: expected ${expectedVersion}, received ${actual ?? 'unknown'}`);
  const checks = [
    {id: 'http', verified: !hasFlag('--without-http'), evidence: 'HTTP core is present unless --without-http is configured.'},
    {id: 'http_ssl', verified: hasFlag('--with-http_ssl_module'), evidence: '--with-http_ssl_module'},
    {id: 'http_proxy', verified: !hasFlag('--without-http_proxy_module'), evidence: 'no --without-http_proxy_module configure flag'},
    {id: 'http_map', verified: !hasFlag('--without-http_map_module'), evidence: 'no --without-http_map_module configure flag'},
    {id: 'http_rewrite', verified: !hasFlag('--without-http_rewrite_module'), evidence: 'no --without-http_rewrite_module configure flag'},
  ];
  const unavailable = checks.filter(item => !item.verified);
  assert.deepEqual(unavailable, [], `Required Nginx modules cannot be verified: ${JSON.stringify(unavailable)}`);
  return {actualVersion: actual, checks};
}

let containerSequence = 0;
async function runNginx(image, root, fixture) {
  const containerName = `forge-nginx-native-${process.pid}-${containerSequence++}`;
  const relative = fixture.directory.slice(root.length + 1).replaceAll('\\', '/');
  const args = ['run', ...dockerSecurityArguments(), '--name', containerName, '--volume', `${root}:/fixtures:ro`, '--entrypoint', 'nginx', image,
    '-t', '-e', 'stderr', '-p', `/fixtures/${relative}/`, '-c', `/fixtures/${relative}/nginx.conf`];
  const result = await runProcess('docker', args);
  if (result.timedOut) await runProcess('docker', ['rm', '--force', containerName], {timeoutMs: 10_000});
  return result;
}

function parserDiagnostics(result) {
  return result.stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line.includes('[emerg]') || line.includes('configuration file'));
}

function evidence(fixture, result) {
  return {
    name: fixture.name,
    profile: fixture.profile,
    source: fixture.source,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    parserDiagnostics: parserDiagnostics(result),
    ...(fixture.equivalentSelectionOrderVerified === true ? {equivalentSelectionOrderVerified: true} : {}),
  };
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Native Nginx validation is confined to an explicitly invoked Linux test environment.');
  const options = parseArguments(process.argv.slice(2));
  await mkdir(dirname(options.report), {recursive: true});
  const root = await mkdtemp(join(tmpdir(), 'forge-nginx-native-'));
  const report = {schemaVersion: '1.0', image: options.image, isolation: {network: 'none', readOnlyRoot: true, capabilities: 'all-dropped', noNewPrivileges: true, containerUser: `${process.getuid()}:${process.getgid()}`, timeoutMs: PROCESS_TIMEOUT_MS}, positive: [], negative: []};
  try {
    const pull = await runProcess('docker', ['pull', options.image], {timeoutMs: PULL_TIMEOUT_MS});
    requireSuccess(pull, `Pull ${options.image}`);
    const digest = await runProcess('docker', ['image', 'inspect', '--format={{index .RepoDigests 0}}', options.image]);
    requireSuccess(digest, 'Inspect image digest');
    report.resolvedImage = digest.stdout.trim();

    const version = await runProcess('docker', ['run', ...dockerSecurityArguments(), '--entrypoint', 'nginx', options.image, '-v']);
    const configure = await runProcess('docker', ['run', ...dockerSecurityArguments(), '--entrypoint', 'nginx', options.image, '-V']);
    requireSuccess(version, 'nginx -v');
    requireSuccess(configure, 'nginx -V');
    report.nginxVersionOutput = `${version.stdout}${version.stderr}`.trim();
    report.nginxConfigureOutput = `${configure.stdout}${configure.stderr}`.trim();
    report.modules = configureChecks(report.nginxVersionOutput, report.nginxConfigureOutput, options.expectedVersion);

    const shared = join(root, 'shared');
    await mkdir(shared, {recursive: true});
    const certificate = await runProcess('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(shared, 'key.pem'), '-out', join(shared, 'cert.pem'), '-subj', '/CN=app.example.com']);
    requireSuccess(certificate, 'Disposable certificate generation');

    const {fixtures: positive, generated} = await materializePositive(root, options.expectedVersion);
    const negative = await materializeNegative(root, generated);
    for (const fixture of positive) {
      const result = await runNginx(options.image, root, fixture);
      report.positive.push(evidence(fixture, result));
      requireSuccess(result, `Positive fixture ${fixture.name}`);
    }
    for (const fixture of negative) {
      const result = await runNginx(options.image, root, fixture);
      report.negative.push({...evidence(fixture, result), expectedFragments: fixture.expected});
      assert.equal(result.timedOut, false, `Negative fixture ${fixture.name} timed out`);
      assert.notEqual(result.exitCode, 0, `Negative fixture ${fixture.name} unexpectedly passed`);
      const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
      for (const fragment of fixture.expected) assert.ok(output.includes(fragment.toLowerCase()), `${fixture.name} did not fail for the intended reason: ${fragment}\n${result.stderr}`);
    }
    report.status = 'passed';
    console.log(`Native Nginx validation passed: ${positive.length} positive and ${negative.length} negative fixtures on ${report.nginxVersionOutput}.`);
  } catch (error) {
    report.status = 'failed';
    report.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
    await rm(root, {recursive: true, force: true});
  }
}

await main();
