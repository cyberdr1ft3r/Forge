import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {readFile} from 'node:fs/promises';

const httpOrigin = process.env.RELEASE_HTTP_URL ?? 'http://127.0.0.1:18080';
const httpsOrigin = process.env.RELEASE_HTTPS_URL ?? 'https://127.0.0.1:18443';
const accessLog = process.env.RELEASE_ACCESS_LOG ?? 'release/logs/access.log';

function request(origin, path, {headers = {}} = {}) {
  const url = new URL(path, origin);
  const implementation = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const call = implementation(url, {headers, rejectUnauthorized: false}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8')}));
    });
    call.on('error', reject);
    call.end();
  });
}

for (const route of ['/', '/generators/nginx', '/generators/compose', '/generators/systemd']) {
  const response = await request(httpsOrigin, route);
  if (response.status !== 200 || !response.body.includes('Forge — Configuration Studio')) throw new Error(`${route} did not serve the Forge entrypoint.`);
  for (const header of ['content-security-policy', 'referrer-policy', 'permissions-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'cross-origin-opener-policy']) {
    if (response.headers[header] === undefined) throw new Error(`${route} is missing ${header}.`);
  }
  if (!String(response.headers['content-security-policy']).includes("default-src 'none'")) throw new Error('CSP is not restrictive by default.');
  if (response.headers['cache-control'] !== 'no-store') throw new Error(`${route} must not be cached.`);
}

for (const [path, contentTypes] of [['/styles.css', ['text/css']], ['/dist/app.js', ['application/javascript', 'text/javascript']]]) {
  const response = await request(httpsOrigin, path);
  if (response.status !== 200) throw new Error(`${path} was not served.`);
  if (!contentTypes.some(contentType => String(response.headers['content-type']).startsWith(contentType))) throw new Error(`${path} has incorrect MIME type: ${response.headers['content-type']}.`);
  if (response.headers['cache-control'] !== 'no-cache') throw new Error(`${path} must revalidate immediately.`);
  if (response.headers.etag === undefined) throw new Error(`${path} is missing an ETag validator.`);
  if (response.headers['x-content-type-options'] !== 'nosniff') throw new Error(`${path} lost inherited security headers.`);
  const conditional = await request(httpsOrigin, path, {headers: {'If-None-Match': response.headers.etag}});
  if (conditional.status !== 304) throw new Error(`${path} did not honor If-None-Match.`);
  if (conditional.headers['cache-control'] !== 'no-cache') throw new Error(`${path} lost no-cache on 304.`);
}

for (const path of ['/unknown', '/missing.js', '/.git/config', '/.env', '/README.md', '/package.json', '/src/app.ts', '/tests/generators.test.js', '/docs/ARCHITECTURE.md', '/dist/app.js.map']) {
  const response = await request(httpsOrigin, path);
  if (response.status !== 404) throw new Error(`${path} returned ${response.status}; expected 404.`);
}

const queryCanary = 'FORGE_QUERY_CANARY_7f3a';
const referrerCanary = 'FORGE_REFERRER_CANARY_2c91';
const agentCanary = 'FORGE_AGENT_CANARY_61bd';
const redirectPath = `/generators/nginx?probe=${queryCanary}`;
const redirect = await request(httpOrigin, redirectPath, {headers: {Referer: `https://referrer.invalid/${referrerCanary}`, 'User-Agent': agentCanary}});
if (redirect.status !== 308 || redirect.headers.location !== `${httpsOrigin}${redirectPath}`) throw new Error('HTTP did not preserve the request target in the configured HTTPS redirect.');

let capturedLog = '';
const redirectLogPattern = /"GET \/generators\/nginx HTTP\/1\.1" 308 [0-9]+/u;
for (let attempt = 0; attempt < 20; attempt += 1) {
  try { capturedLog = await readFile(accessLog, 'utf8'); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (redirectLogPattern.test(capturedLog)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!redirectLogPattern.test(capturedLog)) throw new Error('HTTP redirect log is missing useful method, normalized path, protocol, status, or byte metadata.');
for (const canary of [queryCanary, referrerCanary, agentCanary, 'referrer.invalid']) {
  if (capturedLog.includes(canary)) throw new Error(`Privacy canary leaked into the HTTP access log: ${canary}.`);
}
process.stdout.write('Static Nginx route, log privacy, rejection, MIME, immediate revalidation, HTTPS, and security-header smoke checks passed.\n');
