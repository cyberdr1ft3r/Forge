import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = resolve(projectRoot, 'ops', 'nginx', 'forge-beta.conf.template');
const outputArgument = process.argv.indexOf('--output');
if (outputArgument !== -1 && process.argv[outputArgument + 1] === undefined) throw new Error('--output requires a path.');
const outputPath = resolve(outputArgument === -1 ? resolve(projectRoot, 'release', 'forge-beta.conf') : process.argv[outputArgument + 1]);

const values = {
  FORGE_HTTP_PORT: process.env.FORGE_HTTP_PORT ?? '8080',
  FORGE_HTTPS_PORT: process.env.FORGE_HTTPS_PORT ?? '8443',
  FORGE_SERVER_NAME: process.env.FORGE_SERVER_NAME ?? '_',
  FORGE_RELEASE_ROOT: process.env.FORGE_RELEASE_ROOT ?? '/srv/forge/current',
  FORGE_TLS_CERTIFICATE: process.env.FORGE_TLS_CERTIFICATE ?? '/etc/nginx/tls/fullchain.pem',
  FORGE_TLS_KEY: process.env.FORGE_TLS_KEY ?? '/etc/nginx/tls/privkey.pem',
  FORGE_PUBLIC_ORIGIN: process.env.FORGE_PUBLIC_ORIGIN ?? 'https://localhost:8443',
};

for (const key of ['FORGE_HTTP_PORT', 'FORGE_HTTPS_PORT']) {
  const port = Number(values[key]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${key} must be a TCP port.`);
}
if (values.FORGE_SERVER_NAME !== '_' && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/iu.test(values.FORGE_SERVER_NAME)) throw new Error('FORGE_SERVER_NAME is invalid.');
for (const key of ['FORGE_RELEASE_ROOT', 'FORGE_TLS_CERTIFICATE', 'FORGE_TLS_KEY']) {
  if (!/^\/(?:[A-Za-z0-9._-]+\/?)+$/u.test(values[key]) || values[key].includes('/../')) throw new Error(`${key} must be a safe absolute POSIX path.`);
}
let publicOrigin;
try { publicOrigin = new URL(values.FORGE_PUBLIC_ORIGIN); }
catch { throw new Error('FORGE_PUBLIC_ORIGIN must be a valid HTTPS origin.'); }
if (publicOrigin.protocol !== 'https:' || publicOrigin.username !== '' || publicOrigin.password !== '' || publicOrigin.pathname !== '/' || publicOrigin.search !== '' || publicOrigin.hash !== '') throw new Error('FORGE_PUBLIC_ORIGIN must be an HTTPS origin without credentials or a path.');
values.FORGE_PUBLIC_ORIGIN = publicOrigin.origin;

let rendered = await readFile(templatePath, 'utf8');
for (const [key, value] of Object.entries(values)) rendered = rendered.replaceAll(`__${key}__`, value);
const unresolved = rendered.match(/__[A-Z0-9_]+__/gu);
if (unresolved !== null) throw new Error(`Unresolved Nginx placeholders: ${unresolved.join(', ')}`);
await mkdir(dirname(outputPath), {recursive: true});
await writeFile(outputPath, rendered, 'utf8');
process.stdout.write(`Rendered ${outputPath}\n`);
