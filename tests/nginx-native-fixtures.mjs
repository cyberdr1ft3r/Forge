import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {composeNginxCapabilities} from '../dist/nginx-composition/index.js';

const root = process.env.FORGE_NGINX_FIXTURES;
if (!root?.startsWith('/tmp/')) throw new Error('FORGE_NGINX_FIXTURES must be an absolute /tmp path');
const target = {version:'1.24.0', modules:['http_map','http_proxy','http_rewrite','http_ssl']};
const proxy = {id:'reverse-proxy',input:{domain:'app.example.com',targetHost:'127.0.0.1',targetPort:3000}};
const tls = {id:'tls',input:{certificatePath:join(root,'cert.pem'),privateKeyPath:join(root,'key.pem'),redirectHttp:true}};
const websocket = {id:'websocket',input:{routes:['/','/api/']}};
const routing = {id:'routing',input:{routes:[{prefix:'/api/',targetHost:'127.0.0.1',targetPort:8080,forwarding:'preserve-prefix'},{prefix:'/admin/',targetHost:'127.0.0.1',targetPort:9000,forwarding:'strip-prefix'}]}};
const scenarios = [
  ['http',[proxy],'full-config'],
  ['tls',[proxy,tls],'full-config'],
  ['websocket',[proxy,routing,websocket],'full-config'],
  ['bundle',[proxy,routing,websocket,tls],'site-fragment'],
];
for (const [name, capabilities, profile] of scenarios) {
  const result = composeNginxCapabilities({profile,target,capabilities});
  if (!result.ok) throw new Error(`Composition failed for ${name}: ${JSON.stringify(result.diagnostics)}`);
  const dir = join(root,name);
  await mkdir(dir,{recursive:true});
  if (profile === 'full-config') {
    await writeFile(join(dir,'nginx.conf'),result.artifacts[0].content);
  } else {
    for (const artifact of result.artifacts) await writeFile(join(dir,artifact.filename),artifact.content);
    await writeFile(join(dir,'nginx.conf'), 'events {}\nhttp {\n  include '+join(dir,'http-shared.conf')+';\n  include '+join(dir,'site.conf')+';\n}\n');
  }
}
