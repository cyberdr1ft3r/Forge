import test from 'node:test';
import assert from 'node:assert/strict';
import {
  block,
  directive,
  listBlockDefinitions,
  listDirectiveDefinitions,
  mapEntry,
  nginxArgument as arg,
  serializeNginxDocument,
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
  assert.throws(() => { listDirectiveDefinitions()[0].nginxName = 'raw'; }, TypeError);
  assert.throws(() => { listBlockDefinitions()[0].parents.push('server'); }, TypeError);
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
  for (const value of ['http://upstream.internal:8080', 'https://upstream.internal/api', 'upstream.internal:8080/api', 'upstream.internal:65536']) {
    const diagnostics = validateNginxDocument(upstreamDocument(value));
    assert.ok(diagnostics.some(item => item.code === 'nginx.argument.invalid' && /Upstream address/.test(item.message)), value);
  }
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
