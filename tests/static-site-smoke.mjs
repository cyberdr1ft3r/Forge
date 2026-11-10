import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';

const httpOrigin = process.env.RELEASE_HTTP_URL ?? 'http://127.0.0.1:18080';
const httpsOrigin = process.env.RELEASE_HTTPS_URL ?? 'https://127.0.0.1:18443';

function request(origin, path) {
  const url = new URL(path, origin);
  const implementation = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const call = implementation(url, {rejectUnauthorized: false}, response => {
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
  if (response.headers['cache-control'] !== 'public, max-age=300, must-revalidate') throw new Error(`${path} has incorrect cache policy.`);
  if (response.headers['x-content-type-options'] !== 'nosniff') throw new Error(`${path} lost inherited security headers.`);
}

for (const path of ['/unknown', '/missing.js', '/.git/config', '/.env', '/README.md', '/package.json', '/src/app.ts', '/tests/generators.test.js', '/docs/ARCHITECTURE.md', '/dist/app.js.map']) {
  const response = await request(httpsOrigin, path);
  if (response.status !== 404) throw new Error(`${path} returned ${response.status}; expected 404.`);
}

const redirect = await request(httpOrigin, '/generators/nginx?review=1');
if (redirect.status !== 308 || redirect.headers.location !== `${httpsOrigin}/generators/nginx?review=1`) throw new Error('HTTP did not redirect to the configured HTTPS origin.');
process.stdout.write('Static Nginx route, rejection, MIME, cache, HTTPS, and security-header smoke checks passed.\n');
