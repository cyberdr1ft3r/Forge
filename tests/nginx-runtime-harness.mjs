import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import https from 'node:https';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {composeNginxCapabilities} from '../dist/nginx-composition/index.js';

const OFFICIAL_IMAGE = /^nginx:(\d+\.\d+\.\d+)(?:@sha256:[a-f0-9]{64})?$/;

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--image') values.image = argv[++index];
    else if (argv[index] === '--report') values.report = argv[++index];
    else throw new Error(`Unsupported argument: ${argv[index]}`);
  }
  const match = typeof values.image === 'string' ? OFFICIAL_IMAGE.exec(values.image) : null;
  if (match === null || typeof values.report !== 'string') throw new Error('Pass --image nginx:<version>[@sha256:<digest>] and --report <path>.');
  return {image: values.image, version: match[1], report: resolve(values.report)};
}

function run(command, args, timeoutMs = 30_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('close', exitCode => { clearTimeout(timer); resolveResult({exitCode, timedOut, stdout, stderr}); });
  });
}

function containerUser() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? '101:101' : `${uid}:${gid}`;
}

function httpsRequest(port, {method = 'GET', headers = {}, body} = {}) {
  return new Promise((resolveResult, reject) => {
    const request = https.request({hostname: '127.0.0.1', port, path: '/', method, rejectUnauthorized: false, headers: {host: 'runtime.example.com', ...headers}}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolveResult({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)}));
    });
    request.setTimeout(10_000, () => request.destroy(new Error('HTTPS request timed out')));
    request.once('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const root = await mkdtemp(join(tmpdir(), 'forge-nginx-runtime-'));
  const name = `forge-nginx-runtime-${process.pid}`;
  const network = `${name}-network`;
  const port = 18444;
  const unprivilegedUser = containerUser();
  const report = {schemaVersion: '1.0', image: options.image, isolation: {dedicatedNetwork: true, readOnlyRoot: true, unprivilegedUser, capabilitiesDropped: true}, assertions: {}};
  try {
    await mkdir(join(root, 'www'));
    await writeFile(join(root, 'www', 'index.html'), 'Forge isolated runtime response '.repeat(128));
    const certificate = await run(process.env.OPENSSL_BINARY || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-subj', '/CN=runtime.example.com']);
    assert.equal(certificate.exitCode, 0, certificate.stderr);

    const result = composeNginxCapabilities({profile: 'full-config', target: {version: options.version, modules: ['http_gzip', 'http_headers', 'http_proxy', 'http_ssl']}, capabilities: [
      {id: 'reverse-proxy', input: {domain: 'runtime.example.com', targetHost: '127.0.0.1', targetPort: 8080}},
      {id: 'tls', input: {certificatePath: '/fixtures/cert.pem', privateKeyPath: '/fixtures/key.pem', redirectHttp: false}},
      {id: 'security-headers', input: {preset: 'balanced', hsts: 'one-year'}},
      {id: 'request-timeouts', input: {clientMaxBodySizeMb: 1, clientBodyTimeoutSeconds: 10, clientHeaderTimeoutSeconds: 10, sendTimeoutSeconds: 10, proxy: {connectSeconds: 5, sendSeconds: 10, readSeconds: 10}}},
      {id: 'compression', input: {types: ['text/plain'], minLengthBytes: 256, level: 3, vary: true}},
      {id: 'proxy-buffering', input: {profile: 'bounded', bufferSizeKb: 8, bufferCount: 8, busyBuffersSizeKb: 32, maxTempFileSizeMb: 16}},
    ]});
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const generated = result.artifacts[0].content;
    await writeFile(join(root, 'nginx.conf'), generated.replace('http {', 'http {\n    include /fixtures/runtime-upstream.conf;'));
    await writeFile(join(root, 'runtime-upstream.conf'), 'server { listen 8080; location / { root /fixtures/www; default_type text/plain; } }\n');

    const networkResult = await run('docker', ['network', 'create', network]);
    assert.equal(networkResult.exitCode, 0, networkResult.stderr);
    const started = await run('docker', ['run', '-d', '--name', name, '--network', network, '--publish', `127.0.0.1:${port}:443`, '--user', unprivilegedUser, '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '128m', '--cpus', '0.5', '--tmpfs', '/tmp:rw,noexec,nosuid,mode=1777,size=16m', '--tmpfs', '/var/cache/nginx:rw,noexec,nosuid,mode=1777,size=16m', '--tmpfs', '/var/run:rw,noexec,nosuid,mode=1777,size=4m', '--volume', `${root}:/fixtures:ro`, '--entrypoint', 'nginx', options.image, '-g', 'daemon off; pid /tmp/nginx.pid;', '-c', '/fixtures/nginx.conf']);
    assert.equal(started.exitCode, 0, started.stderr);
    let response;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { response = await httpsRequest(port, {headers: {'accept-encoding': 'gzip'}}); break; }
      catch { await new Promise(resolveWait => setTimeout(resolveWait, 250)); }
    }
    if (response === undefined) {
      const logs = await run('docker', ['logs', name]);
      assert.fail(`Nginx did not become ready.\n${logs.stderr}\n${logs.stdout}`);
    }
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.match(response.headers.vary ?? '', /Accept-Encoding/i);
    assert.equal(response.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-security-policy'] ?? '', /default-src 'self'/);
    const oversized = await httpsRequest(port, {method: 'POST', headers: {'content-length': String(1024 * 1024 + 1)}, body: Buffer.alloc(1024 * 1024 + 1)});
    assert.equal(oversized.status, 413);
    report.assertions = {proxyResponse: 'passed', gzip: 'passed', vary: 'passed', securityHeaders: 'passed', hstsOverHttps: 'passed', requestBodyBound: 'passed', boundedProxyBufferingConfig: generated.includes('proxy_max_temp_file_size 16m;') ? 'passed' : 'failed'};
    assert.equal(report.assertions.boundedProxyBufferingConfig, 'passed');
    console.log(`Isolated Nginx runtime validation passed on ${options.image}.`);
  } finally {
    await run('docker', ['rm', '-f', name]).catch(() => undefined);
    await run('docker', ['network', 'rm', network]).catch(() => undefined);
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
    await rm(root, {recursive: true, force: true});
  }
}

await main();
