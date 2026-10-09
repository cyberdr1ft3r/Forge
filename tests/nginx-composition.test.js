import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeNginxCapabilities,
  composeNginxSites,
  listCapabilityDefinitions,
  mergeSharedHttpResources,
  resolveCapabilityOrder,
} from '../dist/nginx-composition/index.js';
import {block, mapEntry, nginxArgument as arg} from '../dist/nginx-syntax/index.js';

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

const staticSite = (domain = 'static.example.com', overrides = {}) => ({
  id: 'static-site',
  input: {domain, documentRoot: '/var/www/static-site', indexFile: 'index.html', spaFallback: false, ...overrides},
});

const routing = {
  id: 'routing',
  input: {routes: [
    {prefix: '/api/', targetHost: 'api.internal', targetPort: 8080, forwarding: 'preserve-prefix'},
    {prefix: '/admin/', targetHost: 'admin.internal', targetPort: 9000, forwarding: 'strip-prefix'},
  ]},
};

const compose = (capabilities, profile = 'full-config', selectedTarget = target) => composeNginxCapabilities({profile, target: selectedTarget, capabilities});
const siteProxy = (id, domain, port = 3000) => ({id, capabilities: [{id: 'reverse-proxy', input: {domain, targetHost: '127.0.0.1', targetPort: port}}]});
const composeSites = (sites, profile = 'full-config') => composeNginxSites({profile, target, sites});

test('multi-site API is additive and keeps legacy single-site artifacts byte-identical', () => {
  const before = compose([reverseProxy]);
  const after = compose([reverseProxy]);
  assert.equal(before.ok, true);
  assert.deepEqual(after, before);

  const multi = composeSites([siteProxy('app', 'app.example.com')]);
  assert.equal(multi.ok, true);
  assert.equal(multi.provenance.version, '2.1.0');
  assert.deepEqual(multi.provenance.sites, ['app']);
  assert.equal(multi.artifacts[0].content, before.artifacts[0].content);
});

test('two exact-name HTTP sites legitimately share port 80 and are ordered by site identity', () => {
  const sites = [siteProxy('zeta', 'zeta.example.com', 3002), siteProxy('alpha', 'alpha.example.com', 3001)];
  const result = composeSites(sites);
  const reordered = composeSites([...sites].reverse());
  assert.equal(result.ok, true);
  assert.deepEqual(reordered.artifacts, result.artifacts);
  const content = result.artifacts[0].content;
  assert.equal((content.match(/listen 80;/g) ?? []).length, 2);
  assert.ok(content.indexOf('alpha.example.com') < content.indexOf('zeta.example.com'));
});

test('multiple TLS and WebSocket sites share listeners safely and emit one semantic map', () => {
  const sites = ['alpha', 'bravo'].map((id, index) => ({id, capabilities: [
    {id: 'reverse-proxy', input: {domain: `${id}.example.com`, targetHost: '127.0.0.1', targetPort: 3100 + index}},
    {id: 'tls', input: {certificatePath: `/certs/${id}.pem`, privateKeyPath: `/keys/${id}.key`, redirectHttp: false}},
    websocket,
  ]}));
  const result = composeSites(sites);
  assert.equal(result.ok, true);
  const content = result.artifacts[0].content;
  assert.equal((content.match(/listen 443 ssl;/g) ?? []).length, 2);
  assert.equal((content.match(/map \$http_upgrade \$connection_upgrade/g) ?? []).length, 1);
  assert.ok(result.explanations.some(item => item.code === 'composition.shared.dependencies' && item.siteIds?.join(',') === 'alpha,bravo'));
  assert.ok(result.prerequisites.some(item => item.siteId === 'alpha'));
});

test('multi-site fragments contain all servers and exactly one shared HTTP artifact', () => {
  const sites = [siteProxy('plain', 'plain.example.com'), {
    id: 'socket', capabilities: [
      {id: 'reverse-proxy', input: {domain: 'socket.example.com', targetHost: '127.0.0.1', targetPort: 3010}},
      websocket,
    ],
  }];
  const result = composeSites(sites, 'site-fragment');
  assert.equal(result.ok, true);
  assert.deepEqual(result.artifacts.map(item => item.filename), ['site.conf', 'http-shared.conf']);
  assert.equal((result.artifacts[1].content.match(/map \$http_upgrade/g) ?? []).length, 1);
  assert.match(result.artifacts[0].content, /plain\.example\.com/);
  assert.match(result.artifacts[0].content, /socket\.example\.com/);
});

test('listener/name conflicts are site-scoped while distinct protocols and names remain supported', () => {
  const duplicate = composeSites([siteProxy('alpha', 'same.example.com'), siteProxy('bravo', 'same.example.com')]);
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.diagnostics.some(item => item.code === 'composition.server.conflict' && item.siteId === 'bravo'));

  const differentListeners = composeSites([
    siteProxy('http', 'same.example.com'),
    {id: 'https', capabilities: [
      {id: 'reverse-proxy', input: {domain: 'same.example.com', targetHost: '127.0.0.1', targetPort: 3443}},
      tls,
    ]},
  ]);
  assert.equal(differentListeners.ok, true);
});

test('multi-site schemas reject unsupported host patterns, unknown controls, and adversarial identifiers', () => {
  for (const id of ['', 'Upper', '-bad', 'bad-', 'a'.repeat(64), 'site; include /tmp/x']) {
    const result = composeSites([{...siteProxy('valid', 'valid.example.com'), id}]);
    assert.equal(result.ok, false, id);
    assert.ok(result.diagnostics.some(item => item.code === 'composition.site.id'));
  }
  const wildcard = composeSites([siteProxy('wild', '*.example.com')]);
  assert.equal(wildcard.ok, false);
  assert.ok(wildcard.diagnostics.some(item => item.siteId === 'wild' && item.code === 'composition.input.grammar'));
  const defaultServer = composeNginxSites({profile: 'full-config', target, sites: [{...siteProxy('app', 'app.example.com'), defaultServer: true}]});
  assert.equal(defaultServer.ok, false);
  assert.ok(defaultServer.diagnostics.some(item => item.code === 'composition.site.unknown'));
  const duplicateId = composeSites([siteProxy('app', 'a.example.com'), siteProxy('app', 'b.example.com')]);
  assert.equal(duplicateId.ok, false);
  assert.ok(duplicateId.diagnostics.some(item => item.code === 'composition.site.duplicate'));
});

test('shared HTTP resources deduplicate semantically and contradictory definitions fail closed', () => {
  const source = {kind: 'capability', id: 'websocket', version: '2.0.0', siteId: 'alpha'};
  const map = value => block('map', [arg.variable('$http_upgrade'), arg.variable('$connection_upgrade')], [
    mapEntry(arg.keyword('default'), arg.literal(value), source),
  ], source);
  const identical = mergeSharedHttpResources([{siteId: 'bravo', node: map('upgrade')}, {siteId: 'alpha', node: map('upgrade')}]);
  assert.equal(identical.ok, true);
  assert.deepEqual(identical.resources[0].siteIds, ['alpha', 'bravo']);
  const conflict = mergeSharedHttpResources([{siteId: 'alpha', node: map('upgrade')}, {siteId: 'bravo', node: map('close')}]);
  assert.equal(conflict.ok, false);
  assert.ok(conflict.diagnostics.some(item => item.code === 'composition.shared.conflict' && item.siteId === 'bravo'));
});

test('multi-site expansion remains bounded', () => {
  const result = composeSites(Array.from({length: 17}, (_, index) => siteProxy(`site-${index}`, `site-${index}.example.com`)));
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(item => item.code === 'composition.sites.count'));
});

test('capability registry is typed, versioned, immutable, and adds only the Phase 4A static shelf', () => {
  const definitions = listCapabilityDefinitions();
  assert.deepEqual(definitions.map(item => item.id).sort(), ['reverse-proxy', 'routing', 'static-site', 'tls', 'websocket']);
  assert.ok(definitions.every(item => /^\d+\.\d+\.\d+$/.test(item.version)));
  assert.ok(definitions.every(item => item.inputSchema.additionalProperties === false));
  assert.ok(definitions.every(item => item.astSurface.contexts.length > 0));
  assert.throws(() => { definitions[0].dependencies.push('tls'); }, TypeError);
});

test('static website emits typed root, index, MIME resources, and an explicit 404 fallback', () => {
  const result = compose([staticSite()]);
  assert.equal(result.ok, true);
  const content = result.artifacts[0].content;
  assert.match(content, /include \/etc\/nginx\/mime\.types;/);
  assert.match(content, /default_type application\/octet-stream;/);
  assert.match(content, /server_name static\.example\.com;/);
  assert.match(content, /root \/var\/www\/static-site;/);
  assert.match(content, /index index\.html;/);
  assert.match(content, /try_files \$uri \$uri\/ =404;/);
  assert.ok(result.prerequisites.some(item => item.kind === 'directory' && item.path === '/var/www/static-site'));
  assert.ok(result.prerequisites.some(item => item.code === 'composition.static.permissions'));
  assert.equal(result.validation.targetHost.status, 'not-run');
});

test('SPA mode safely derives its entry fallback without claiming missing assets return 404', () => {
  const result = compose([staticSite('spa.example.com', {indexFile: 'app-shell.html', spaFallback: true})]);
  assert.equal(result.ok, true);
  assert.match(result.artifacts[0].content, /try_files \$uri \$uri\/ \/app-shell\.html;/);
  assert.doesNotMatch(result.artifacts[0].content, /=404;/);
  assert.ok(result.explanations.some(item => item.code === 'composition.static.spa-fallback' && /internally redirect/.test(item.message)));
});

test('static site supports TLS and optional HTTP redirect without a fake proxy dependency', () => {
  const result = compose([staticSite('secure-static.example.com'), {...tls, input: {...tls.input, redirectHttp: true}}]);
  assert.equal(result.ok, true);
  const content = result.artifacts[0].content;
  assert.match(content, /listen 443 ssl;/);
  assert.match(content, /listen 80;/);
  assert.match(content, /return 301 https:\/\/secure-static\.example\.com\$request_uri;/);
  assert.equal((content.match(/root \/var\/www\/static-site;/g) ?? []).length, 1);
});

test('multi-site composition supports static, SPA, proxy, and WebSocket proxy sites together', () => {
  const sites = [
    {id: 'static', capabilities: [staticSite('static.example.com')]},
    {id: 'spa', capabilities: [staticSite('spa.example.com', {documentRoot: '/srv/spa', spaFallback: true})]},
    siteProxy('proxy', 'proxy.example.com'),
    {id: 'socket', capabilities: [
      {id: 'reverse-proxy', input: {domain: 'socket.example.com', targetHost: '127.0.0.1', targetPort: 3010}},
      websocket,
    ]},
  ];
  const first = composeSites(sites);
  const second = composeSites([...sites].reverse());
  assert.equal(first.ok, true);
  assert.deepEqual(second.artifacts, first.artifacts);
  const content = first.artifacts[0].content;
  assert.equal((content.match(/include \/etc\/nginx\/mime\.types;/g) ?? []).length, 1);
  assert.equal((content.match(/map \$http_upgrade \$connection_upgrade/g) ?? []).length, 1);
  assert.match(content, /server_name static\.example\.com;/);
  assert.match(content, /server_name proxy\.example\.com;/);
});

test('different static sites may deliberately share one document root', () => {
  const result = composeSites([
    {id: 'alpha', capabilities: [staticSite('alpha.example.com', {documentRoot: '/srv/shared'})]},
    {id: 'bravo', capabilities: [staticSite('bravo.example.com', {documentRoot: '/srv/shared'})]},
  ]);
  assert.equal(result.ok, true);
  assert.equal((result.artifacts[0].content.match(/root \/srv\/shared;/g) ?? []).length, 2);
});

test('static site fragments emit one ancillary MIME artifact with accurate ownership', () => {
  const result = compose([staticSite()], 'site-fragment');
  assert.equal(result.ok, true);
  assert.deepEqual(result.artifacts.map(item => item.filename), ['site.conf', 'http-shared.conf']);
  assert.match(result.artifacts[1].content, /include \/etc\/nginx\/mime\.types;/);
  assert.ok(result.explanations.some(item => item.code === 'composition.artifact.http-shared' && item.capabilityId === 'static-site'));
});

test('static and proxy root ownership conflicts are rejected without changing route semantics', () => {
  const sameDomain = compose([staticSite('app.example.com'), reverseProxy]);
  assert.equal(sameDomain.ok, false);
  assert.ok(sameDomain.diagnostics.some(item => item.code === 'composition.site.root-conflict'));

  const differentDomain = compose([staticSite('static.example.com'), reverseProxy]);
  assert.equal(differentDomain.ok, false);
  assert.ok(differentDomain.diagnostics.some(item => item.code === 'composition.site.domain-conflict'));

  const spaRoutes = compose([staticSite('app.example.com', {spaFallback: true}), reverseProxy, routing]);
  assert.equal(spaRoutes.ok, false);
  assert.ok(spaRoutes.diagnostics.some(item => item.code === 'composition.site.root-conflict'));
});

test('static-site input rejects unsafe roots, filenames, coercion, and directive injection', () => {
  const invalidRoots = ['/', 'relative/site', '/var/www/', '/var//www', '/var/../secret', '/var/www/$root', '/var/www/*', '/var/www/site;return'];
  for (const documentRoot of invalidRoots) {
    const result = compose([staticSite('static.example.com', {documentRoot})]);
    assert.equal(result.ok, false, documentRoot);
    assert.deepEqual(result.artifacts, []);
    assert.ok(result.diagnostics.some(item => item.code === 'composition.input.grammar'));
  }
  for (const indexFile of ['', '../index.html', '/index.html', 'folder/index.html', 'index.html;return', '$uri', 'a'.repeat(129)]) {
    const result = compose([staticSite('static.example.com', {indexFile})]);
    assert.equal(result.ok, false, indexFile);
    assert.deepEqual(result.artifacts, []);
  }
  for (const spaFallback of ['true', 1, null, {}]) {
    const result = compose([staticSite('static.example.com', {spaFallback})]);
    assert.equal(result.ok, false, String(spaFallback));
    assert.ok(result.diagnostics.some(item => item.code === 'composition.input.boolean'));
  }
});

test('TLS without any trusted site owner remains invalid', () => {
  const result = compose([tls]);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(item => item.code === 'composition.dependency.site-owner'));
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
  assert.equal(result.validation.targetHost.status, 'not-run');
  assert.equal(result.validation.targetHost.validator, 'target-host nginx readiness');
  assert.ok(result.validation.targetHost.diagnostics.some(item => item.code === 'target-host.not-run'));
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
  assert.equal(profile.validation.targetHost.status, 'not-run');

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
