import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeNginxCapabilities,
  listCapabilityDefinitions,
  resolveCapabilityOrder,
} from '../dist/nginx-composition/index.js';

const target = {
  version: '1.24.0',
  modules: ['http_map', 'http_proxy', 'http_rewrite', 'http_ssl'],
};

const reverseProxy = {
  id: 'reverse-proxy',
  input: {domain: 'app.example.com', targetHost: '127.0.0.1', targetPort: 3000},
};

const tls = {
  id: 'tls',
  input: {
    certificatePath: '/etc/nginx/certs/app.example.com.pem',
    privateKeyPath: '/etc/nginx/private/app.example.com.key',
    redirectHttp: false,
  },
};

const websocket = {
  id: 'websocket',
  input: {routes: ['/']},
};

const routing = {
  id: 'routing',
  input: {routes: [
    {prefix: '/api/', targetHost: 'api.internal', targetPort: 8080, forwarding: 'preserve-prefix'},
    {prefix: '/admin/', targetHost: 'admin.internal', targetPort: 9000, forwarding: 'strip-prefix'},
  ]},
};

const compose = (capabilities, profile = 'full-config', selectedTarget = target) => composeNginxCapabilities({profile, target: selectedTarget, capabilities});

test('capability registry is typed, versioned, immutable, and limited to the four Phase 2 shelves', () => {
  const definitions = listCapabilityDefinitions();
  assert.deepEqual(definitions.map(item => item.id).sort(), ['reverse-proxy', 'routing', 'tls', 'websocket']);
  assert.ok(definitions.every(item => /^\d+\.\d+\.\d+$/.test(item.version)));
  assert.ok(definitions.every(item => item.inputSchema.additionalProperties === false));
  assert.ok(definitions.every(item => item.astSurface.contexts.length > 0));
  assert.throws(() => { definitions[0].dependencies.push('tls'); }, TypeError);
});

test('HTTP reverse proxy composes a validated deterministic full configuration', () => {
  const result = compose([reverseProxy]);
  assert.equal(result.ok, true);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0]?.role, 'primary');
  assert.equal(result.artifacts[0]?.filename, 'nginx.conf');
  assert.match(result.artifacts[0]?.content ?? '', /listen 80;/);
  assert.match(result.artifacts[0]?.content ?? '', /server_name app\.example\.com;/);
  assert.match(result.artifacts[0]?.content ?? '', /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.match(result.artifacts[0]?.content ?? '', /proxy_http_version 1\.1;/);
  assert.ok(result.explanations.some(item => item.code === 'composition.proxy.route'));
  assert.equal(result.validation.static.status, 'passed');
  assert.equal(result.validation.native.status, 'unavailable');
});

test('TLS adds an HTTPS listener only with explicit certificate and key paths', () => {
  const result = compose([reverseProxy, tls]);
  assert.equal(result.ok, true);
  const content = result.artifacts[0]?.content ?? '';
  assert.match(content, /listen 443 ssl;/);
  assert.match(content, /ssl_certificate \/etc\/nginx\/certs\/app\.example\.com\.pem;/);
  assert.match(content, /ssl_certificate_key \/etc\/nginx\/private\/app\.example\.com\.key;/);
  assert.match(content, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
  assert.doesNotMatch(content, /listen 80;/);
  assert.equal(result.prerequisites.filter(item => item.kind === 'file').length, 2);
});

test('HTTPS redirect creates a separate HTTP server tied to the TLS listener', () => {
  const redirectTls = {...tls, input: {...tls.input, redirectHttp: true}};
  const result = compose([reverseProxy, redirectTls]);
  assert.equal(result.ok, true);
  const content = result.artifacts[0]?.content ?? '';
  assert.match(content, /listen 80;/);
  assert.match(content, /return 301 https:\/\/app\.example\.com\$request_uri;/);
  assert.doesNotMatch(content, /https:\/\/\$host/);
  assert.match(content, /listen 443 ssl;/);
  assert.equal((content.match(/proxy_pass /g) ?? []).length, 1);
  assert.ok(result.explanations.some(item => item.code === 'composition.tls.redirect'));
});

test('WebSocket support adds one shared HTTP map and route-scoped upgrade headers', () => {
  const result = compose([websocket, reverseProxy]);
  assert.equal(result.ok, true);
  const content = result.artifacts[0]?.content ?? '';
  assert.equal((content.match(/map \$http_upgrade \$connection_upgrade/g) ?? []).length, 1);
  assert.match(content, /default upgrade;/);
  assert.match(content, /"" close;/);
  assert.match(content, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(content, /proxy_set_header Connection \$connection_upgrade;/);
});

test('TLS and WebSocket compose without duplicate shared resources', () => {
  const result = compose([tls, websocket, reverseProxy]);
  assert.equal(result.ok, true);
  const content = result.artifacts[0]?.content ?? '';
  assert.equal((content.match(/map \$http_upgrade \$connection_upgrade/g) ?? []).length, 1);
  assert.equal((content.match(/listen 443 ssl;/g) ?? []).length, 1);
  assert.equal((content.match(/proxy_set_header Upgrade/g) ?? []).length, 1);
});

test('routing supports distinct upstreams and explicit URI forwarding semantics', () => {
  const result = compose([routing, reverseProxy]);
  assert.equal(result.ok, true);
  const content = result.artifacts[0]?.content ?? '';
  assert.match(content, /location \/api\/ \{[\s\S]*proxy_pass http:\/\/api\.internal:8080;/);
  assert.match(content, /location \/admin\/ \{[\s\S]*proxy_pass http:\/\/admin\.internal:9000\//);
  assert.equal((content.match(/location /g) ?? []).length, 3);
  assert.ok(result.explanations.some(item => item.code === 'composition.route.preserve-prefix'));
  assert.ok(result.explanations.some(item => item.code === 'composition.route.strip-prefix'));
});

test('multiple WebSocket routes share one map and site profile emits an HTTP ancillary artifact', () => {
  const routedWebSocket = {id: 'websocket', input: {routes: ['/', '/api/']}};
  const result = compose([routing, routedWebSocket, reverseProxy], 'site-fragment');
  assert.equal(result.ok, true);
  assert.equal(result.artifacts.filter(item => item.role === 'primary').length, 1);
  assert.equal(result.artifacts.length, 2);
  const primary = result.artifacts.find(item => item.role === 'primary');
  const supporting = result.artifacts.find(item => item.role === 'supporting');
  assert.equal(primary?.filename, 'site.conf');
  assert.equal(supporting?.filename, 'http-shared.conf');
  assert.doesNotMatch(primary?.content ?? '', /^map /m);
  assert.equal(((supporting?.content ?? '').match(/map \$http_upgrade \$connection_upgrade/g) ?? []).length, 1);
  assert.equal(((primary?.content ?? '').match(/proxy_set_header Upgrade/g) ?? []).length, 2);
  assert.ok(result.prerequisites.some(item => item.code === 'composition.artifact.include-http'));
});

test('duplicate routes and conflicting duplicate capability settings are rejected', () => {
  const duplicateRoot = {id: 'routing', input: {routes: [
    {prefix: '/', targetHost: 'other.internal', targetPort: 8080, forwarding: 'preserve-prefix'},
  ]}};
  const routeResult = compose([reverseProxy, duplicateRoot]);
  assert.equal(routeResult.ok, false);
  assert.ok(routeResult.diagnostics.some(item => item.code === 'composition.route.duplicate'));

  const capabilityResult = compose([reverseProxy, tls, {...tls, input: {...tls.input, redirectHttp: true}}]);
  assert.equal(capabilityResult.ok, false);
  assert.ok(capabilityResult.diagnostics.some(item => item.code === 'composition.capability.duplicate'));
});

test('TLS rejects missing, unsafe, traversal, glob, and conflicting certificate prerequisites', () => {
  const invalidInputs = [
    {privateKeyPath: '/etc/nginx/private/key.pem', redirectHttp: false},
    {certificatePath: '/etc/nginx/../secret.pem', privateKeyPath: '/etc/nginx/key.pem', redirectHttp: false},
    {certificatePath: '/etc/nginx/*.pem', privateKeyPath: '/etc/nginx/key.pem', redirectHttp: false},
    {certificatePath: '/etc/nginx/certs/', privateKeyPath: '/etc/nginx/key.pem', redirectHttp: false},
    {certificatePath: '/', privateKeyPath: '/etc/nginx/key.pem', redirectHttp: false},
    {certificatePath: '/etc/nginx/shared.pem', privateKeyPath: '/etc/nginx/shared.pem', redirectHttp: false},
    {certificatePath: '/etc/nginx/cert.pem\nreturn 200', privateKeyPath: '/etc/nginx/key.pem', redirectHttp: false},
  ];
  for (const input of invalidInputs) {
    const result = compose([reverseProxy, {id: 'tls', input}]);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.stage === 'input'));
  }
});

test('unsupported profiles, versions, and required modules fail actionably', () => {
  const profile = composeNginxCapabilities({profile: 'http-fragment', target, capabilities: [reverseProxy]});
  assert.equal(profile.ok, false);
  assert.ok(profile.diagnostics.some(item => item.code === 'composition.profile.unsupported'));

  const version = compose([reverseProxy], 'full-config', {...target, version: '1.17.9'});
  assert.equal(version.ok, false);
  assert.ok(version.diagnostics.some(item => item.code === 'composition.target.version-unsupported'));

  const module = compose([reverseProxy, websocket], 'full-config', {...target, modules: ['http_proxy']});
  assert.equal(module.ok, false);
  assert.ok(module.diagnostics.some(item => item.code === 'composition.target.module-missing' && /http_map/.test(item.message)));
});

test('equivalent capability selections produce byte-identical artifacts and explanations', () => {
  const first = compose([reverseProxy, routing, tls, {id: 'websocket', input: {routes: ['/', '/api/']}}]);
  const second = compose([{id: 'websocket', input: {routes: ['/api/', '/']}}, tls, routing, reverseProxy]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second.artifacts, first.artifacts);
  assert.deepEqual(second.explanations, first.explanations);
  assert.deepEqual(second.provenance, first.provenance);
});

test('malformed and malicious capability inputs never reach artifact generation', () => {
  const attacks = [
    {id: 'reverse-proxy', input: {domain: 'safe.test; return 200', targetHost: '127.0.0.1', targetPort: 3000}},
    {id: 'reverse-proxy', input: {domain: 'safe.test', targetHost: '127.0.0.1; include /tmp/pwn', targetPort: 3000}},
    {id: 'reverse-proxy', input: {domain: 'safe.test', targetHost: '999.999.999.999', targetPort: 3000}},
    {id: 'reverse-proxy', input: {domain: 'safe.test', targetHost: '127.0.0.1', targetPort: '3000'}},
    {id: 'reverse-proxy', input: {domain: 'safe.test', targetHost: '127.0.0.1', targetPort: 3000, raw: 'return 200;'}},
  ];
  for (const attack of attacks) {
    const result = compose([attack]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.artifacts, []);
    assert.ok(result.diagnostics.some(item => item.stage === 'input'));
  }
});

test('WebSocket dependency and compatible-route constraints are explicit', () => {
  const missingDependency = compose([websocket]);
  assert.equal(missingDependency.ok, false);
  assert.ok(missingDependency.diagnostics.some(item => item.code === 'composition.dependency.missing'));

  const missingRoute = compose([reverseProxy, {id: 'websocket', input: {routes: ['/chat/']}}]);
  assert.equal(missingRoute.ok, false);
  assert.ok(missingRoute.diagnostics.some(item => item.code === 'composition.websocket.route-missing'));

  const duplicateRoute = compose([reverseProxy, {id: 'websocket', input: {routes: ['/', '/']}}]);
  assert.equal(duplicateRoute.ok, false);
  assert.ok(duplicateRoute.diagnostics.some(item => item.code === 'composition.websocket.duplicate'));
});

test('dependency resolver rejects cycles independently of the trusted capability registry', () => {
  const result = resolveCapabilityOrder([
    {id: 'a', dependencies: ['b']},
    {id: 'b', dependencies: ['c']},
    {id: 'c', dependencies: ['a']},
  ], ['a', 'b', 'c']);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(item => item.code === 'composition.dependency.cycle'));
});

test('bounded schemas reject capability and route expansion', () => {
  const tooManyCapabilities = composeNginxCapabilities({profile: 'full-config', target, capabilities: Array.from({length: 17}, () => reverseProxy)});
  assert.equal(tooManyCapabilities.ok, false);
  assert.ok(tooManyCapabilities.diagnostics.some(item => item.code === 'composition.capabilities.count'));

  const tooManyRoutes = {id: 'routing', input: {routes: Array.from({length: 33}, (_, index) => ({
    prefix: `/route-${index}/`, targetHost: 'service.internal', targetPort: 8080, forwarding: 'preserve-prefix',
  }))}};
  const routeResult = compose([reverseProxy, tooManyRoutes]);
  assert.equal(routeResult.ok, false);
  assert.ok(routeResult.diagnostics.some(item => item.code === 'composition.routes.count'));
});
