import test from 'node:test';
import assert from 'node:assert/strict';
import {
  block,
  directive,
  FORGE_JSON_LOG_FORMAT_NAME,
  FORGE_JSON_LOG_FORMAT_TEMPLATE,
  listBlockDefinitions,
  listDirectiveDefinitions,
  mapEntry,
  nginxArgument as arg,
  serializeNginxDocument,
  serializeNginxHttpFragment,
  validateNginxDocument,
} from '../dist/nginx-syntax/index.js';

const source = {kind: 'engine', id: 'nginx-syntax', version: '1.0.0'};

const locationBlock = () => block('location', [arg.locationPrefix('/')], [
  directive('proxy_set_header', [arg.headerName('Host'), arg.variable('$host')], source),
  directive('proxy_pass', [arg.proxyUrl('http://127.0.0.1:3000')], source),
], source);

const serverBlock = () => block('server', [], [
  locationBlock(),
  directive('server_name', [arg.domain('app.example.com')], source),
  directive('listen', [arg.integer(80)], source),
], source);

const fullDocument = () => ({
  profile: 'full-config',
  source,
  children: [
    block('http', [], [
      serverBlock(),
      block('upstream', [arg.identifier('backend')], [
        directive('keepalive', [arg.integer(16)], source),
        directive('upstream_server', [arg.upstreamAddress('127.0.0.1:3000')], source),
      ], source),
      block('map', [arg.variable('$scheme'), arg.variable('$connection_upgrade')], [
        mapEntry(arg.keyword('default'), arg.keyword('off'), source),
        mapEntry(arg.literal('https'), arg.keyword('on'), source),
      ], source),
      directive('default_type', [arg.literal('application/octet-stream')], source),
    ], source),
    directive('worker_processes', [arg.keyword('auto')], source),
    block('events', [], [directive('worker_connections', [arg.integer(1024)], source)], source),
  ],
});

test('trusted registries expose the supported Phase 1 surface without arbitrary registration', () => {
  assert.deepEqual(listBlockDefinitions().map(item => item.blockType), ['events', 'http', 'map', 'upstream', 'server', 'location']);
  assert.ok(listDirectiveDefinitions().some(item => item.id === 'proxy_pass' && item.contexts.includes('location')));
  assert.ok(listDirectiveDefinitions().some(item => item.id === 'upstream_server' && item.nginxName === 'server'));
  assert.ok(listDirectiveDefinitions().some(item => item.id === 'access_log' && item.contexts.includes('location')));
  assert.ok(listDirectiveDefinitions().some(item => item.id === 'log_format' && item.contexts.length === 1 && item.contexts[0] === 'http'));
  assert.ok(listDirectiveDefinitions().some(item => item.id === 'limit_req_zone' && item.contexts.length === 1 && item.contexts[0] === 'http'));
  assert.ok(listDirectiveDefinitions().some(item => item.id === 'limit_conn_zone' && item.contexts.length === 1 && item.contexts[0] === 'http'));
  assert.throws(() => { listDirectiveDefinitions()[0].nginxName = 'raw'; }, TypeError);
  assert.throws(() => { listBlockDefinitions()[0].parents.push('server'); }, TypeError);
});

test('trusted logging directives serialize deterministically with a fixed JSON preset', () => {
  const document = fullDocument();
  const http = document.children.find(node => node.kind === 'block' && node.blockType === 'http');
  const server = http.children.find(node => node.kind === 'block' && node.blockType === 'server');
  http.children.push(directive('log_format', [
    arg.logFormatName(FORGE_JSON_LOG_FORMAT_NAME),
    arg.keyword('escape=json'),
    arg.logFormatTemplate(FORGE_JSON_LOG_FORMAT_TEMPLATE),
  ], source));
  server.children.push(
    directive('access_log', [arg.filePath('/var/log/nginx/app.access.log'), arg.logFormatName(FORGE_JSON_LOG_FORMAT_NAME)], source),
    directive('error_log', [arg.filePath('/var/log/nginx/app.error.log'), arg.keyword('warn')], source),
  );
  const result = serializeNginxDocument(document);
  assert.equal(result.ok, true);
  assert.match(result.artifacts[0].content, /log_format forge_json_v1 escape=json '\{"time":"\$time_iso8601"/);
  assert.match(result.artifacts[0].content, /access_log \/var\/log\/nginx\/app\.access\.log forge_json_v1;/);
  assert.match(result.artifacts[0].content, /error_log \/var\/log\/nginx\/app\.error\.log warn;/);

  const disabled = {profile: 'site-fragment', source, children: [block('server', [], [
    directive('access_log', [arg.keyword('off')], source),
    directive('error_log', [arg.filePath('/var/log/nginx/app.error.log')], source),
  ], source)]};
  assert.equal(serializeNginxDocument(disabled).ok, true);
});

test('logging grammar rejects invalid contexts, shapes, names, templates, paths, and severities', () => {
  const invalidNodes = [
    directive('access_log', [arg.keyword('off'), arg.keyword('combined')], source),
    directive('access_log', [arg.filePath('/var/log/nginx/access.log')], source),
    directive('access_log', [arg.filePath('/var/log/nginx/access.log'), arg.logFormatName('custom')], source),
    directive('error_log', [arg.filePath('/var/log/nginx/error.log'), arg.keyword('verbose')], source),
    directive('error_log', [arg.filePath('/var/log/../error.log'), arg.keyword('error')], source),
  ];
  for (const node of invalidNodes) {
    const result = serializeNginxDocument({profile: 'site-fragment', source, children: [block('server', [], [node], source)]});
    assert.equal(result.ok, false, node.name);
  }

  const wrongContext = fullDocument();
  const http = wrongContext.children.find(node => node.kind === 'block' && node.blockType === 'http');
  const server = http.children.find(node => node.kind === 'block' && node.blockType === 'server');
  server.children.push(directive('log_format', [arg.logFormatName(FORGE_JSON_LOG_FORMAT_NAME), arg.keyword('escape=json'), arg.logFormatTemplate(FORGE_JSON_LOG_FORMAT_TEMPLATE)], source));
  assert.ok(validateNginxDocument(wrongContext).some(item => item.code === 'nginx.directive.context'));

  const injectedTemplate = fullDocument();
  const injectedHttp = injectedTemplate.children.find(node => node.kind === 'block' && node.blockType === 'http');
  injectedHttp.children.push(directive('log_format', [arg.logFormatName(FORGE_JSON_LOG_FORMAT_NAME), arg.keyword('escape=json'), {kind: 'log-format-template', value: `${FORGE_JSON_LOG_FORMAT_TEMPLATE}; include /tmp/pwn`}], source));
  assert.ok(validateNginxDocument(injectedTemplate).some(item => item.code === 'nginx.argument.invalid'));
});

test('duplicate trusted log-format declarations are rejected by semantic key', () => {
  const document = fullDocument();
  const http = document.children.find(node => node.kind === 'block' && node.blockType === 'http');
  const format = () => directive('log_format', [arg.logFormatName(FORGE_JSON_LOG_FORMAT_NAME), arg.keyword('escape=json'), arg.logFormatTemplate(FORGE_JSON_LOG_FORMAT_TEMPLATE)], source);
  http.children.push(format(), format());
  const diagnostics = validateNginxDocument(document);
  assert.ok(diagnostics.some(item => item.code === 'nginx.directive.duplicate'));
});

test('trusted traffic-limiting directives serialize in HTTP and server contexts', () => {
  const document = fullDocument();
  const http = document.children.find(node => node.kind === 'block' && node.blockType === 'http');
  const server = http.children.find(node => node.kind === 'block' && node.blockType === 'server');
  http.children.push(
    directive('limit_req_zone', [arg.variable('$binary_remote_addr'), arg.requestLimitZoneDefinition('zone=forge_req_api:10m'), arg.requestLimitRate('rate=25r/s')], source),
    directive('limit_conn_zone', [arg.variable('$binary_remote_addr'), arg.connectionLimitZoneDefinition('zone=forge_conn_api:8m')], source),
  );
  server.children.push(
    directive('limit_req', [arg.requestLimitZoneReference('zone=forge_req_api'), arg.requestLimitBurst('burst=10'), arg.keyword('nodelay')], source),
    directive('limit_req_status', [arg.integer(429)], source),
    directive('limit_conn', [arg.connectionLimitZoneName('forge_conn_api'), arg.integer(20)], source),
    directive('limit_conn_status', [arg.integer(503)], source),
  );
  const result = serializeNginxDocument(document);
  assert.equal(result.ok, true);
  const content = result.artifacts[0].content;
  assert.match(content, /limit_req_zone \$binary_remote_addr zone=forge_req_api:10m rate=25r\/s;/);
  assert.match(content, /limit_conn_zone \$binary_remote_addr zone=forge_conn_api:8m;/);
  assert.match(content, /limit_req zone=forge_req_api burst=10 nodelay;/);
  assert.match(content, /limit_conn forge_conn_api 20;/);
});

test('traffic-limiting grammar rejects unsafe keys, cross-kind names, invalid bounds, and contexts', () => {
  const invalidHttpNodes = [
    directive('limit_req_zone', [arg.variable('$remote_addr'), arg.requestLimitZoneDefinition('zone=forge_req_api:10m'), arg.requestLimitRate('rate=1r/s')], source),
    directive('limit_req_zone', [arg.variable('$binary_remote_addr'), arg.requestLimitZoneDefinition('zone=forge_req_bad;include:10m'), arg.requestLimitRate('rate=1r/s')], source),
    directive('limit_req_zone', [arg.variable('$binary_remote_addr'), arg.requestLimitZoneDefinition('zone=forge_req_api:33m'), arg.requestLimitRate('rate=1r/s')], source),
    directive('limit_req_zone', [arg.variable('$binary_remote_addr'), arg.requestLimitZoneDefinition('zone=forge_req_api:10m'), arg.requestLimitRate('rate=0r/s')], source),
    directive('limit_conn_zone', [arg.variable('$binary_remote_addr'), arg.connectionLimitZoneDefinition('zone=forge_req_api:10m')], source),
  ];
  for (const node of invalidHttpNodes) {
    const diagnostics = validateNginxDocument({profile: 'full-config', source, children: [block('events', [], [], source), block('http', [], [node, serverBlock()], source)]});
    assert.ok(diagnostics.some(item => item.severity === 'error'), node.name);
  }

  const invalidServerNodes = [
    directive('limit_req', [arg.requestLimitZoneReference('zone=forge_conn_api')], source),
    directive('limit_req', [arg.requestLimitZoneReference('zone=forge_req_api'), arg.requestLimitBurst('burst=0')], source),
    directive('limit_req_status', [arg.integer(399)], source),
    directive('limit_conn', [arg.connectionLimitZoneName('forge_req_api'), arg.integer(1)], source),
    directive('limit_conn', [arg.connectionLimitZoneName('forge_conn_api'), arg.integer(10_001)], source),
    directive('limit_conn_status', [arg.integer(600)], source),
  ];
  for (const node of invalidServerNodes) {
    const result = serializeNginxDocument({profile: 'site-fragment', source, children: [block('server', [], [node], source)]});
    assert.equal(result.ok, false, node.name);
  }

  const illegalContext = {profile: 'full-config', source, children: [
    block('events', [], [directive('limit_req', [arg.requestLimitZoneReference('zone=forge_req_api')], source)], source),
    block('http', [], [serverBlock()], source),
  ]};
  assert.ok(validateNginxDocument(illegalContext).some(item => item.code === 'nginx.directive.context'));
});

test('traffic zone duplicate detection uses the zone identity rather than the shared key', () => {
  const zone = (name, rate) => directive('limit_req_zone', [
    arg.variable('$binary_remote_addr'),
    arg.requestLimitZoneDefinition(`zone=${name}:10m`),
    arg.requestLimitRate(`rate=${rate}r/s`),
  ], source);
  const distinct = {profile: 'full-config', source, children: [block('events', [], [], source), block('http', [], [zone('forge_req_alpha', 1), zone('forge_req_bravo', 2), serverBlock()], source)]};
  assert.equal(serializeNginxDocument(distinct).ok, true);
  const duplicate = {profile: 'full-config', source, children: [block('events', [], [], source), block('http', [], [zone('forge_req_alpha', 1), zone('forge_req_alpha', 2), serverBlock()], source)]};
  assert.ok(validateNginxDocument(duplicate).some(item => item.code === 'nginx.directive.duplicate'));
  const conflictingSize = {profile: 'full-config', source, children: [block('events', [], [], source), block('http', [], [
    zone('forge_req_alpha', 1),
    directive('limit_req_zone', [arg.variable('$binary_remote_addr'), arg.requestLimitZoneDefinition('zone=forge_req_alpha:12m'), arg.requestLimitRate('rate=1r/s')], source),
    serverBlock(),
  ], source)]};
  assert.ok(validateNginxDocument(conflictingSize).some(item => item.code === 'nginx.directive.duplicate'));
});

test('full configuration validates and serializes every supported context deterministically', () => {
  const result = serializeNginxDocument(fullDocument());
  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.artifacts[0]?.filename, 'nginx.conf');
  assert.equal(result.artifacts[0]?.content, `worker_processes auto;

events {
    worker_connections 1024;
}

http {
    default_type application/octet-stream;
    map $scheme $connection_upgrade {
        default off;
        https on;
    }
    upstream backend {
        server 127.0.0.1:3000;
        keepalive 16;
    }
    server {
        listen 80;
        server_name app.example.com;
        location / {
            proxy_pass http://127.0.0.1:3000;
            proxy_set_header Host $host;
        }
    }
}
`);

  const reordered = fullDocument();
  reordered.children.reverse();
  const http = reordered.children.find(node => node.kind === 'block' && node.blockType === 'http');
  http.children.reverse();
  assert.equal(serializeNginxDocument(reordered).artifacts[0]?.content, result.artifacts[0]?.content);
});

test('site fragment emits server roots without an invalid http wrapper', () => {
  const result = serializeNginxDocument({profile: 'site-fragment', source, children: [serverBlock()]});
  assert.equal(result.ok, true);
  assert.equal(result.artifacts[0]?.filename, 'site.conf');
  assert.match(result.artifacts[0]?.content ?? '', /^server \{/);
  assert.doesNotMatch(result.artifacts[0]?.content ?? '', /^http \{/m);
});

test('invalid directive context and block nesting return actionable AST paths', () => {
  const invalidContext = fullDocument();
  const http = invalidContext.children.find(node => node.kind === 'block' && node.blockType === 'http');
  http.children.push(directive('proxy_pass', [arg.proxyUrl('http://127.0.0.1:3000')], source));
  const contextDiagnostics = validateNginxDocument(invalidContext);
  assert.ok(contextDiagnostics.some(item => item.code === 'nginx.directive.context' && item.path?.includes('children')));

  const invalidNesting = fullDocument();
  const invalidHttp = invalidNesting.children.find(node => node.kind === 'block' && node.blockType === 'http');
  invalidHttp.children.push(locationBlock());
  assert.ok(validateNginxDocument(invalidNesting).some(item => item.code === 'nginx.block.context' && /location/.test(item.message)));
});

test('unsupported directives and node kinds are rejected at runtime', () => {
  const document = fullDocument();
  const http = document.children.find(node => node.kind === 'block' && node.blockType === 'http');
  http.children.push({kind: 'directive', name: 'raw_snippet', args: [], source});
  const result = serializeNginxDocument(document);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(item => item.code === 'nginx.directive.unsupported' && item.path?.endsWith('.name')));
});

test('unsafe arguments reject syntax injection, traversal, invalid variables, and oversized ports', () => {
  const attacks = [
    directive('server_name', [arg.domain('safe.test; return 200')], source),
    directive('root', [arg.path('/srv/../secret')], source),
    directive('proxy_pass', [arg.proxyUrl('http://127.0.0.1:3000\ninclude /tmp/pwn')], source),
    directive('proxy_pass', [arg.proxyUrl('http://backend/$host')], source),
    directive('proxy_pass', [arg.proxyUrl('http://bad..host:3000')], source),
    directive('proxy_set_header', [arg.headerName('X-Test\rInjected'), arg.variable('$host')], source),
    directive('listen', [arg.integer(65_536)], source),
    directive('proxy_set_header', [arg.headerName('Host'), {kind: 'variable', value: '$unsafe_variable'}], source),
  ];
  for (const attack of attacks) {
    const document = {profile: 'site-fragment', source, children: [block('server', [], [attack], source)]};
    const result = serializeNginxDocument(document);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.code === 'nginx.argument.invalid'));
  }
});

test('proxy_pass requires a literal HTTP(S) URL instead of a generic endpoint', () => {
  const validValues = [
    'http://upstream.internal',
    'https://upstream.internal:8443/api/v1',
    'http://[::1]:3000',
  ];
  for (const value of validValues) {
    const document = {profile: 'site-fragment', source, children: [block('server', [], [
      block('location', [arg.locationPrefix('/api')], [directive('proxy_pass', [arg.proxyUrl(value)], source)], source),
    ], source)]};
    assert.equal(serializeNginxDocument(document).ok, true, value);
  }

  const invalidValues = [
    'upstream.internal',
    'upstream.internal:8080',
    'ftp://upstream.internal',
    'http://upstream.internal/$request_uri',
  ];
  for (const value of invalidValues) {
    const document = {profile: 'site-fragment', source, children: [block('server', [], [
      block('location', [arg.locationPrefix('/api')], [directive('proxy_pass', [arg.proxyUrl(value)], source)], source),
    ], source)]};
    const diagnostics = validateNginxDocument(document);
    assert.ok(diagnostics.some(item => item.code === 'nginx.argument.invalid' && /Proxy URL/.test(item.message)), value);
  }
});

test('upstream server requires an address and rejects URL or path syntax', () => {
  const upstreamDocument = value => ({
    profile: 'full-config',
    source,
    children: [
      block('events', [], [], source),
      block('http', [], [
        block('upstream', [arg.identifier('backend')], [
          directive('upstream_server', [arg.upstreamAddress(value)], source),
        ], source),
      ], source),
    ],
  });

  for (const value of ['upstream.internal', 'upstream.internal:8080', '127.0.0.1:3000', '[::1]:3000']) {
    assert.equal(serializeNginxDocument(upstreamDocument(value)).ok, true, value);
  }
  for (const value of ['http://upstream.internal:8080', 'https://upstream.internal/api', 'upstream.internal:8080/api', 'upstream.internal:65536', '999.999.999.999:8080']) {
    const diagnostics = validateNginxDocument(upstreamDocument(value));
    assert.ok(diagnostics.some(item => item.code === 'nginx.argument.invalid' && /Upstream address/.test(item.message)), value);
  }
});

test('Phase 4B upstream directives accept only bounded typed parameters and Forge-owned references', () => {
  const upstreamSource = {kind: 'capability', id: 'upstream-load-balancing', version: '4.1.0'};
  const upstreamBlock = children => block('upstream', [arg.identifier('forge_app_pool')], children, upstreamSource);
  const document = children => ({profile: 'full-config', source, children: [
    block('events', [], [], source),
    block('http', [], [upstreamBlock(children)], source),
  ]});
  const valid = document([
    directive('least_conn', [], upstreamSource),
    directive('upstream_server', [arg.upstreamAddress('[2001:db8::1]:8080'), arg.upstreamParameter('weight=100'), arg.upstreamParameter('max_fails=0'), arg.upstreamParameter('fail_timeout=300s')], upstreamSource),
    directive('upstream_server', [arg.upstreamAddress('backend.internal:8080'), arg.upstreamParameter('backup')], upstreamSource),
  ]);
  assert.equal(serializeNginxDocument(valid).ok, true);

  for (const parameter of ['weight=0', 'weight=101', 'max_fails=11', 'fail_timeout=0s', 'fail_timeout=301s', 'slow_start=5s', 'backup; include /tmp/x']) {
    const invalid = document([directive('upstream_server', [arg.upstreamAddress('127.0.0.1:8080'), arg.upstreamParameter(parameter)], upstreamSource)]);
    assert.ok(validateNginxDocument(invalid).some(item => item.code === 'nginx.argument.invalid'), parameter);
  }
  const duplicateParameter = document([directive('upstream_server', [arg.upstreamAddress('127.0.0.1:8080'), arg.upstreamParameter('weight=2'), arg.upstreamParameter('weight=3')], upstreamSource)]);
  assert.ok(validateNginxDocument(duplicateParameter).some(item => item.code === 'nginx.upstream.parameter-duplicate'));
  const contradictoryState = document([directive('upstream_server', [arg.upstreamAddress('127.0.0.1:8080'), arg.upstreamParameter('backup'), arg.upstreamParameter('down')], upstreamSource)]);
  assert.ok(validateNginxDocument(contradictoryState).some(item => item.code === 'nginx.upstream.backend-state'));

  const reference = value => ({profile: 'site-fragment', source, children: [block('server', [], [
    block('location', [arg.locationPrefix('/')], [directive('proxy_pass', [arg.upstreamUrl(value)], upstreamSource)], upstreamSource),
  ], upstreamSource)]});
  assert.equal(serializeNginxDocument(reference('http://forge_app_pool')).ok, true);
  assert.equal(serializeNginxDocument(reference('http://forge_app_pool/')).ok, true);
  for (const value of ['http://app_pool', 'https://forge_app_pool', 'http://forge_app-pool', 'http://forge_app_pool/path', 'http://forge_app_pool;return']) {
    assert.ok(validateNginxDocument(reference(value)).some(item => item.code === 'nginx.argument.invalid'), value);
  }

  const wrongContext = {profile: 'site-fragment', source, children: [block('server', [], [directive('least_conn', [], upstreamSource)], upstreamSource)]};
  assert.ok(validateNginxDocument(wrongContext).some(item => item.code === 'nginx.directive.context'));
});

test('proxy URLs and upstream addresses strictly validate bracketed IPv6', () => {
  const proxyDocument = value => ({
    profile: 'site-fragment',
    source,
    children: [block('server', [], [
      block('location', [arg.locationPrefix('/')], [directive('proxy_pass', [arg.proxyUrl(value)], source)], source),
    ], source)],
  });
  const upstreamDocument = value => ({
    profile: 'full-config',
    source,
    children: [
      block('events', [], [], source),
      block('http', [], [
        block('upstream', [arg.identifier('backend')], [
          directive('upstream_server', [arg.upstreamAddress(value)], source),
        ], source),
      ], source),
    ],
  });

  const validHosts = [
    '[::]',
    '[::1]',
    '[2001:db8::1]',
    '[2001:0db8:0000:0000:0000:ff00:0042:8329]',
    '[::ffff:192.0.2.128]',
  ];
  for (const host of validHosts) {
    assert.equal(serializeNginxDocument(proxyDocument(`https://${host}:8443/api`)).ok, true, `proxy ${host}`);
    assert.equal(serializeNginxDocument(upstreamDocument(`${host}:8443`)).ok, true, `upstream ${host}`);
  }

  const invalidHosts = [
    '[1:2]',
    '[1::2::3]',
    '[12345::1]',
    '[2001:db8:0:0:0:0:0:0:1]',
    '[2001:db8::gggg]',
    '[::ffff:999.0.2.1]',
  ];
  for (const host of invalidHosts) {
    assert.ok(validateNginxDocument(proxyDocument(`http://${host}`)).some(item => item.code === 'nginx.argument.invalid'), `proxy ${host}`);
    assert.ok(validateNginxDocument(upstreamDocument(host)).some(item => item.code === 'nginx.argument.invalid'), `upstream ${host}`);
  }

  for (const port of ['0', '65536', '999999']) {
    assert.ok(validateNginxDocument(proxyDocument(`http://[::1]:${port}`)).some(item => item.code === 'nginx.argument.invalid'), `proxy port ${port}`);
    assert.ok(validateNginxDocument(upstreamDocument(`[::1]:${port}`)).some(item => item.code === 'nginx.argument.invalid'), `upstream port ${port}`);
  }
});

test('Phase 2 directives remain constrained to trusted contexts and argument grammars', () => {
  const tlsSource = {kind: 'capability', id: 'tls', version: '2.0.0'};
  const valid = {profile: 'site-fragment', source, children: [block('server', [], [
    directive('listen', [arg.integer(443), arg.keyword('ssl')], tlsSource),
    directive('server_name', [arg.domain('secure.example.com')], source),
    directive('ssl_certificate', [arg.filePath('/etc/nginx/cert.pem')], tlsSource),
    directive('ssl_certificate_key', [arg.filePath('/etc/nginx/private/key.pem')], tlsSource),
    directive('ssl_protocols', [arg.keyword('TLSv1.2'), arg.keyword('TLSv1.3')], tlsSource),
  ], tlsSource)]};
  assert.equal(serializeNginxDocument(valid).ok, true);

  const unsafe = structuredClone(valid);
  unsafe.children[0].children[2].args[0].value = '/etc/nginx/*.pem';
  assert.ok(validateNginxDocument(unsafe).some(item => item.code === 'nginx.argument.invalid'));

  const invalidContext = {profile: 'full-config', source, children: [
    block('events', [], [directive('ssl_certificate', [arg.filePath('/etc/nginx/cert.pem')], tlsSource)], source),
    block('http', [], [], source),
  ]};
  assert.ok(validateNginxDocument(invalidContext).some(item => item.code === 'nginx.directive.context'));
});

test('Phase 4A static directives use closed path, filename, and try_files grammars', () => {
  const staticSource = {kind: 'capability', id: 'static-site', version: '4.0.0'};
  const staticDocument = fallback => ({profile: 'site-fragment', source, children: [block('server', [], [
    directive('listen', [arg.integer(80)], staticSource),
    directive('server_name', [arg.domain('static.example.com')], staticSource),
    directive('root', [arg.directoryPath('/var/www/static-site')], staticSource),
    directive('index', [arg.indexFile('index.html')], staticSource),
    block('location', [arg.locationPrefix('/')], [
      directive('try_files', [arg.tryFileCandidate('$uri'), arg.tryFileCandidate('$uri/'), arg.tryFileFallback(fallback)], staticSource),
    ], staticSource),
  ], staticSource)]});

  assert.equal(serializeNginxDocument(staticDocument('=404')).ok, true);
  assert.equal(serializeNginxDocument(staticDocument('/index.html')).ok, true);

  const malformed = [
    directive('root', [arg.directoryPath('/var/www/../secret')], staticSource),
    directive('index', [arg.indexFile('../index.html')], staticSource),
    directive('try_files', [arg.tryFileCandidate('$uri'), arg.tryFileCandidate('$uri/')], staticSource),
    directive('try_files', [arg.tryFileCandidate('$uri'), {kind: 'try-file-candidate', value: '$uri;return'}, arg.tryFileFallback('=404')], staticSource),
    directive('try_files', [arg.tryFileCandidate('$uri'), arg.tryFileCandidate('$uri/'), arg.tryFileFallback('/../secret')], staticSource),
  ];
  for (const node of malformed) {
    const document = {profile: 'site-fragment', source, children: [block('server', [], [node], staticSource)]};
    const diagnostics = validateNginxDocument(document);
    assert.ok(diagnostics.some(item => item.code === 'nginx.argument.invalid' || item.code === 'nginx.argument.missing'));
  }

  const wrongContext = {profile: 'full-config', source, children: [
    block('events', [], [directive('try_files', [arg.tryFileCandidate('$uri'), arg.tryFileCandidate('$uri/'), arg.tryFileFallback('=404')], staticSource)], source),
    block('http', [], [], source),
  ]};
  assert.ok(validateNginxDocument(wrongContext).some(item => item.code === 'nginx.directive.context'));
});

test('HTTP fragments validate map placement without introducing a third document profile', () => {
  const websocketSource = {kind: 'capability', id: 'websocket', version: '2.0.0'};
  const result = serializeNginxHttpFragment([block('map', [arg.variable('$http_upgrade'), arg.variable('$connection_upgrade')], [
    mapEntry(arg.keyword('default'), arg.literal('upgrade'), websocketSource),
    mapEntry(arg.quoted(''), arg.literal('close'), websocketSource),
  ], websocketSource)]);
  assert.equal(result.ok, true);
  assert.equal(result.artifacts[0]?.filename, 'http-shared.conf');
  assert.match(result.artifacts[0]?.content ?? '', /^map \$http_upgrade \$connection_upgrade \{/);
  assert.match(result.artifacts[0]?.content ?? '', /"" close;/);
});

test('location headers accept literal prefixes and reject unsupported matching semantics', () => {
  const locationDocument = value => ({
    profile: 'site-fragment',
    source,
    children: [block('server', [], [block('location', [arg.locationPrefix(value)], [], source)], source)],
  });

  for (const value of ['/', '/api/', '/assets-v1/images']) {
    assert.equal(serializeNginxDocument(locationDocument(value)).ok, true, value);
  }
  for (const value of ['/images/*.jpg', '/search?term', '/../secret', '//api', '~', '@fallback', '^~ /assets']) {
    const diagnostics = validateNginxDocument(locationDocument(value));
    assert.ok(diagnostics.some(item => item.code === 'nginx.argument.invalid' && /Location prefix/.test(item.message)), value);
  }
});

test('quoted values are escaped as one argument without variable expansion', () => {
  const document = {profile: 'site-fragment', source, children: [block('server', [], [
    directive('listen', [arg.integer(80)], source),
    directive('server_name', [arg.domain('quoted.example.com')], source),
    block('location', [arg.locationPrefix('/')], [
      directive('proxy_set_header', [arg.headerName('X-Test'), arg.quoted('hello "world" $host; } \\')], source),
      directive('proxy_pass', [arg.proxyUrl('http://127.0.0.1:3000')], source),
    ], source),
  ], source)]};
  const result = serializeNginxDocument(document);
  assert.equal(result.ok, true);
  assert.ok((result.artifacts[0]?.content ?? '').includes('proxy_set_header X-Test "hello \\"world\\" \\$host; } \\\\";'));
});

test('duplicate directives, blocks, map keys, and server identities are diagnosed', () => {
  const duplicateLocation = block('server', [], [locationBlock(), locationBlock()], source);
  assert.ok(validateNginxDocument({profile: 'site-fragment', source, children: [duplicateLocation]}).some(item => item.code === 'nginx.block.duplicate'));

  const duplicateListen = block('server', [], [
    directive('listen', [arg.integer(80)], source),
    directive('listen', [arg.integer(80), arg.keyword('default_server')], source),
  ], source);
  assert.ok(validateNginxDocument({profile: 'site-fragment', source, children: [duplicateListen]}).some(item => item.code === 'nginx.directive.duplicate'));

  const map = block('map', [arg.variable('$scheme'), arg.variable('$connection_upgrade')], [
    mapEntry(arg.keyword('default'), arg.keyword('off'), source),
    mapEntry(arg.literal('default'), arg.keyword('on'), source),
  ], source);
  const document = fullDocument();
  const http = document.children.find(node => node.kind === 'block' && node.blockType === 'http');
  http.children.push(map);
  assert.ok(validateNginxDocument(document).some(item => item.code === 'nginx.map-entry.duplicate'));

  assert.ok(validateNginxDocument({profile: 'site-fragment', source, children: [serverBlock(), serverBlock()]}).some(item => item.code === 'nginx.server.conflict'));

  const defaultServer = serverBlock();
  const listen = defaultServer.children.find(node => node.kind === 'directive' && node.name === 'listen');
  listen.args.push(arg.keyword('default_server'));
  assert.ok(validateNginxDocument({profile: 'site-fragment', source, children: [serverBlock(), defaultServer]}).some(item => item.code === 'nginx.server.conflict'));
});

test('server conflict validation allows shared ports but rejects overlapping names and listener modes', () => {
  const virtualServer = (name, option) => block('server', [], [
    directive('listen', option === undefined ? [arg.integer(443)] : [arg.integer(443), arg.keyword(option)], source),
    directive('server_name', [arg.domain(name)], source),
  ], source);

  const sharedPort = {profile: 'site-fragment', source, children: [virtualServer('a.example.com', 'ssl'), virtualServer('b.example.com', 'ssl')]};
  assert.deepEqual(validateNginxDocument(sharedPort), []);

  const duplicateName = {profile: 'site-fragment', source, children: [virtualServer('same.example.com', 'ssl'), virtualServer('same.example.com', 'ssl')]};
  assert.ok(validateNginxDocument(duplicateName).some(item => item.code === 'nginx.server.conflict'));

  const modeConflict = {profile: 'site-fragment', source, children: [virtualServer('a.example.com', 'ssl'), virtualServer('b.example.com')]};
  assert.ok(validateNginxDocument(modeConflict).some(item => item.code === 'nginx.listener.mode-conflict'));

  const defaults = {profile: 'site-fragment', source, children: [virtualServer('a.example.com', 'default_server'), virtualServer('b.example.com', 'default_server')]};
  assert.ok(validateNginxDocument(defaults).some(item => item.code === 'nginx.listener.default-conflict'));
});

test('site provenance accepts stable IDs and rejects unsafe IDs', () => {
  const valid = {...source, siteId: 'customer-a'};
  assert.deepEqual(validateNginxDocument({profile: 'site-fragment', source: valid, children: [block('server', [], [directive('listen', [arg.integer(80)], valid), directive('server_name', [arg.domain('a.example.com')], valid)], valid)]}), []);
  const invalid = {...source, siteId: 'bad;include'};
  assert.ok(validateNginxDocument({profile: 'site-fragment', source: invalid, children: [serverBlock()]}).some(item => item.code === 'nginx.source.site-id'));
});

test('output profiles reject incomplete and context-specific root combinations', () => {
  assert.ok(validateNginxDocument({profile: 'full-config', source, children: []}).some(item => item.code === 'nginx.profile.events'));
  assert.ok(validateNginxDocument({profile: 'full-config', source, children: []}).some(item => item.code === 'nginx.profile.http'));
  assert.ok(validateNginxDocument({profile: 'site-fragment', source, children: [block('http', [], [], source)]}).some(item => item.code === 'nginx.profile.site-root'));
  assert.ok(validateNginxDocument({profile: 'unknown', source, children: []}).some(item => item.code === 'nginx.profile.unsupported'));
});

test('map entries outside map context and malformed provenance are rejected', () => {
  const document = {profile: 'site-fragment', source: {kind: 'engine', id: 'Invalid ID'}, children: [block('server', [], [mapEntry(arg.literal('key'), arg.literal('value'), source)], source)]};
  const diagnostics = validateNginxDocument(document);
  assert.ok(diagnostics.some(item => item.code === 'nginx.source.id' && item.path === 'document.source.id'));
  assert.ok(diagnostics.some(item => item.code === 'nginx.map-entry.context'));
});

test('boundary values are accepted or rejected without throwing', () => {
  const maximum = {profile: 'site-fragment', source, children: [block('server', [], [
    directive('listen', [arg.integer(65_535)], source),
    directive('server_name', [arg.domain('boundary.example.com')], source),
    block('location', [arg.locationPrefix('/')], [
      directive('proxy_pass', [arg.proxyUrl('http://127.0.0.1:3000')], source),
      directive('proxy_set_header', [arg.headerName('X-Boundary'), arg.quoted('a'.repeat(1024))], source),
    ], source),
  ], source)]};
  assert.equal(serializeNginxDocument(maximum).ok, true);

  const oversized = structuredClone(maximum);
  const location = oversized.children[0].children.find(node => node.kind === 'block');
  const header = location.children.find(node => node.kind === 'directive' && node.name === 'proxy_set_header');
  header.args[1].value = 'a'.repeat(1025);
  assert.equal(serializeNginxDocument(oversized).ok, false);
});

test('malformed runtime objects produce diagnostics instead of escaping validation', () => {
  const malformedDocuments = [
    {profile: 'full-config', source, children: [null, block('events', [], [], source), block('http', [], [], source)]},
    {profile: 'site-fragment', source, children: [{kind: 'block', blockType: 'server', header: [], source}]},
    {profile: 'site-fragment', source, children: [{kind: 'directive', name: 'listen', args: null, source}]},
    {profile: 'site-fragment', source, children: [{kind: 'block', blockType: 'server', header: null, children: [null], source}]},
  ];
  for (const document of malformedDocuments) {
    assert.doesNotThrow(() => validateNginxDocument(document));
    const result = serializeNginxDocument(document);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some(item => item.severity === 'error'));
  }
});
