import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {composeNginxCapabilities, composeNginxSites} from '../dist/nginx-composition/index.js';

const PROCESS_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const OFFICIAL_IMAGE = /^nginx:(\d+\.\d+\.\d+)(?:@sha256:[a-f0-9]{64})?$/;
const REQUIRED_MODULES = ['http_limit_conn', 'http_limit_req', 'http_log', 'http_map', 'http_proxy', 'http_rewrite', 'http_ssl'];

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
    '--tmpfs', '/tmp:rw,noexec,nosuid,mode=1777,size=16m',
    '--tmpfs', '/var/cache/nginx:rw,noexec,nosuid,mode=1777,size=16m',
    '--tmpfs', '/var/run:rw,noexec,nosuid,mode=1777,size=4m',
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

function composeSites(request, name) {
  const result = composeNginxSites(request);
  assert.equal(result.ok, true, `${name} multi-site composition failed: ${JSON.stringify(result.diagnostics)}`);
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

function multiRequest(version, sites, profile = 'full-config') {
  return {profile, target: {version, modules: REQUIRED_MODULES}, sites};
}

function nativeSite(id, domain, port, extra = []) {
  return {id, capabilities: [
    {id: 'reverse-proxy', input: {domain, targetHost: '127.0.0.1', targetPort: port}},
    ...extra,
  ]};
}

function staticCapability(domain, documentRoot, spaFallback = false) {
  return {id: 'static-site', input: {domain, documentRoot, indexFile: 'index.html', spaFallback}};
}

function upstreamProxy(domain = 'balanced.example.com', upstreamId = 'app-pool') {
  return {id: 'reverse-proxy', input: {domain, upstreamId}};
}

function upstreamCapability(upstreamId = 'app-pool', strategy = 'round-robin', backends = [
  {host: '127.0.0.1', port: 4101, weight: 3, maxFails: 2, failTimeoutSeconds: 15},
  {host: '127.0.0.1', port: 4102, backup: true},
]) {
  return {id: 'upstream-load-balancing', input: {upstreamId, strategy, backends}};
}

function loggingCapability(name, accessLog = 'combined', errorLogLevel = 'error') {
  return {id: 'logging', input: {
    accessLog,
    ...(accessLog === 'off' ? {} : {accessLogPath: `/tmp/${name}.access.log`}),
    errorLogPath: `/tmp/${name}.error.log`,
    errorLogLevel,
  }};
}

function trafficCapability(policyId, overrides = {}) {
  return {id: 'traffic-limiting', input: {
    policyId,
    requestLimit: {rate: 20, unit: 'second', burst: 10, nodelay: false, zoneSizeMb: 10, statusCode: 429},
    connectionLimit: {connections: 25, zoneSizeMb: 10, statusCode: 429},
    ...overrides,
  }};
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

  const loggingCombined = loggingCapability('logging-combined', 'combined', 'warn');
  const loggingJson = loggingCapability('logging-json', 'forge-json', 'notice');
  fixtures.push({...await materializeComposition(root, 'logging-combined', compose(compositionRequest(version, [proxy, loggingCombined]), 'logging-combined'), 'full-config'), source: 'forge-logging-output'});
  fixtures.push({...await materializeComposition(root, 'logging-off', compose(compositionRequest(version, [proxy, loggingCapability('logging-off', 'off', 'crit')]), 'logging-off'), 'full-config'), source: 'forge-logging-output'});
  fixtures.push({...await materializeComposition(root, 'logging-json', compose(compositionRequest(version, [proxy, loggingJson]), 'logging-json'), 'full-config'), source: 'forge-logging-output'});
  fixtures.push({...await materializeComposition(root, 'logging-tls-websocket', compose(compositionRequest(version, [proxy, websocketRoot, tls(true), loggingCapability('logging-tls-websocket', 'forge-json')]), 'logging-tls-websocket'), 'full-config'), source: 'forge-logging-output'});

  const requestOnly = trafficCapability('request-only', {connectionLimit: undefined, requestLimit: {rate: 5, unit: 'second', burst: 0, nodelay: false, zoneSizeMb: 4, statusCode: 429}});
  const connectionOnly = trafficCapability('connection-only', {requestLimit: undefined, connectionLimit: {connections: 12, zoneSizeMb: 4, statusCode: 503}});
  const bothCustom = trafficCapability('both-custom', {requestLimit: {rate: 30, unit: 'minute', burst: 15, nodelay: true, zoneSizeMb: 8, statusCode: 429}, connectionLimit: {connections: 8, zoneSizeMb: 6, statusCode: 429}});
  fixtures.push({...await materializeComposition(root, 'traffic-request-only', compose(compositionRequest(version, [proxy, requestOnly]), 'traffic-request-only'), 'full-config'), source: 'forge-traffic-limiting-output'});
  fixtures.push({...await materializeComposition(root, 'traffic-connection-only', compose(compositionRequest(version, [proxy, connectionOnly]), 'traffic-connection-only'), 'full-config'), source: 'forge-traffic-limiting-output'});
  fixtures.push({...await materializeComposition(root, 'traffic-both-custom', compose(compositionRequest(version, [proxy, bothCustom]), 'traffic-both-custom'), 'full-config'), source: 'forge-traffic-limiting-output'});
  fixtures.push({...await materializeComposition(root, 'traffic-tls-websocket', compose(compositionRequest(version, [proxy, websocketRoot, tls(true), trafficCapability('tls-websocket')]), 'traffic-tls-websocket'), 'full-config'), source: 'forge-traffic-limiting-output'});

  const httpSites = [nativeSite('alpha', 'alpha.example.com', 3101), nativeSite('bravo', 'bravo.example.com', 3102)];
  const multiHttp = composeSites(multiRequest(version, httpSites), 'multi-http-sites');
  fixtures.push({...await materializeComposition(root, 'multi-http-sites', multiHttp, 'full-config'), source: 'forge-multi-site-output'});

  const tlsSites = [
    nativeSite('alpha-tls', 'alpha-tls.example.com', 3201, [{id: 'tls', input: {certificatePath: '/fixtures/shared/cert.pem', privateKeyPath: '/fixtures/shared/key.pem', redirectHttp: false}}]),
    nativeSite('bravo-tls', 'bravo-tls.example.com', 3202, [{id: 'tls', input: {certificatePath: '/fixtures/shared/cert-two.pem', privateKeyPath: '/fixtures/shared/key-two.pem', redirectHttp: false}}]),
  ];
  fixtures.push({...await materializeComposition(root, 'multi-https-sites', composeSites(multiRequest(version, tlsSites), 'multi-https-sites'), 'full-config'), source: 'forge-multi-site-output'});

  const websocketSites = [nativeSite('alpha-ws', 'alpha-ws.example.com', 3301, [websocketRoot]), nativeSite('bravo-ws', 'bravo-ws.example.com', 3302, [websocketRoot])];
  const multiWebSocket = composeSites(multiRequest(version, websocketSites), 'multi-websocket-sites');
  assert.equal((multiWebSocket.artifacts[0].content.match(/map \$http_upgrade/g) ?? []).length, 1, 'multi-site WebSocket map must be emitted once');
  fixtures.push({...await materializeComposition(root, 'multi-websocket-sites', multiWebSocket, 'full-config'), source: 'forge-multi-site-output'});

  const mixedSites = [httpSites[0], tlsSites[0], nativeSite('routed-ws', 'routed.example.com', 3401, [routing, websocketRoutes])];
  fixtures.push({...await materializeComposition(root, 'multi-mixed-sites', composeSites(multiRequest(version, mixedSites), 'multi-mixed-sites'), 'full-config'), source: 'forge-multi-site-output'});
  fixtures.push({...await materializeComposition(root, 'multi-site-fragment-bundle', composeSites(multiRequest(version, websocketSites, 'site-fragment'), 'multi-site-fragment-bundle'), 'site-fragment'), source: 'forge-multi-site-output'});

  const reversed = composeSites(multiRequest(version, [...mixedSites].reverse()), 'multi-site-order-reversed');
  const canonical = composeSites(multiRequest(version, mixedSites), 'multi-site-order-canonical');
  assert.deepEqual(reversed.artifacts, canonical.artifacts, 'Equivalent site orders must emit byte-identical artifacts');
  fixtures.push({...await materializeComposition(root, 'multi-site-order-determinism', canonical, 'full-config'), source: 'forge-multi-site-output', equivalentSelectionOrderVerified: true});

  const staticStandard = staticCapability('static.example.com', '/fixtures/shared/static-standard');
  const staticSpa = staticCapability('spa.example.com', '/fixtures/shared/static-spa', true);
  fixtures.push({...await materializeComposition(root, 'static-website', compose(compositionRequest(version, [staticStandard]), 'static-website'), 'full-config'), source: 'forge-static-site-output'});
  fixtures.push({...await materializeComposition(root, 'static-spa', compose(compositionRequest(version, [staticSpa]), 'static-spa'), 'full-config'), source: 'forge-static-site-output'});

  const multiStaticSites = [
    {id: 'static-alpha', capabilities: [staticCapability('static-alpha.example.com', '/fixtures/shared/static-standard')]},
    {id: 'static-bravo', capabilities: [staticCapability('static-bravo.example.com', '/fixtures/shared/static-spa', true)]},
  ];
  fixtures.push({...await materializeComposition(root, 'multi-static-sites', composeSites(multiRequest(version, multiStaticSites), 'multi-static-sites'), 'full-config'), source: 'forge-static-site-output'});

  const staticProxySites = [multiStaticSites[0], nativeSite('proxy-alongside-static', 'proxy-alongside-static.example.com', 3601)];
  fixtures.push({...await materializeComposition(root, 'static-and-proxy', composeSites(multiRequest(version, staticProxySites), 'static-and-proxy'), 'full-config'), source: 'forge-static-site-output'});
  fixtures.push({...await materializeComposition(root, 'static-and-tls', compose(compositionRequest(version, [staticStandard, tls(false)]), 'static-and-tls'), 'full-config'), source: 'forge-static-site-output'});
  fixtures.push({...await materializeComposition(root, 'logging-static', compose(compositionRequest(version, [staticStandard, loggingCapability('logging-static', 'combined', 'info')]), 'logging-static'), 'full-config'), source: 'forge-logging-output'});
  fixtures.push({...await materializeComposition(root, 'traffic-static', compose(compositionRequest(version, [staticStandard, trafficCapability('static')]), 'traffic-static'), 'full-config'), source: 'forge-traffic-limiting-output'});

  const staticSocketSites = [multiStaticSites[0], nativeSite('socket-alongside-static', 'socket-alongside-static.example.com', 3602, [websocketRoot])];
  fixtures.push({...await materializeComposition(root, 'static-and-websocket-proxy', composeSites(multiRequest(version, staticSocketSites), 'static-and-websocket-proxy'), 'full-config'), source: 'forge-static-site-output'});
  fixtures.push({...await materializeComposition(root, 'static-site-fragment-bundle', compose(compositionRequest(version, [staticStandard], 'site-fragment'), 'static-site-fragment-bundle'), 'site-fragment'), source: 'forge-static-site-output'});

  const staticOrderA = composeSites(multiRequest(version, [multiStaticSites[1], staticProxySites[1], multiStaticSites[0]]), 'static-order-a');
  const staticOrderB = composeSites(multiRequest(version, [multiStaticSites[0], multiStaticSites[1], staticProxySites[1]]), 'static-order-b');
  assert.deepEqual(staticOrderA.artifacts, staticOrderB.artifacts, 'Equivalent static-site orders must emit byte-identical artifacts');
  fixtures.push({...await materializeComposition(root, 'static-site-order-determinism', staticOrderA, 'full-config'), source: 'forge-static-site-output', equivalentSelectionOrderVerified: true});

  const balancedProxy = upstreamProxy();
  const roundRobin = upstreamCapability();
  const leastConnections = upstreamCapability('least-pool', 'least-connections', [
    {host: '127.0.0.1', port: 4201, weight: 4, maxFails: 0, failTimeoutSeconds: 30},
    {host: '127.0.0.1', port: 4202},
    {host: '127.0.0.1', port: 4203, down: true},
  ]);
  fixtures.push({...await materializeComposition(root, 'upstream-weighted-round-robin', compose(compositionRequest(version, [balancedProxy, roundRobin]), 'upstream-weighted-round-robin'), 'full-config'), source: 'forge-upstream-output'});
  fixtures.push({...await materializeComposition(root, 'upstream-least-connections', compose(compositionRequest(version, [upstreamProxy('least.example.com', 'least-pool'), leastConnections]), 'upstream-least-connections'), 'full-config'), source: 'forge-upstream-output'});
  fixtures.push({...await materializeComposition(root, 'upstream-tls-websocket', compose(compositionRequest(version, [balancedProxy, roundRobin, tls(false), websocketRoot]), 'upstream-tls-websocket'), 'full-config'), source: 'forge-upstream-output'});
  fixtures.push({...await materializeComposition(root, 'logging-upstream', compose(compositionRequest(version, [balancedProxy, roundRobin, loggingCapability('logging-upstream', 'forge-json', 'alert')]), 'logging-upstream'), 'full-config'), source: 'forge-logging-output'});
  fixtures.push({...await materializeComposition(root, 'traffic-upstream-logging', compose(compositionRequest(version, [balancedProxy, roundRobin, loggingCapability('traffic-upstream-logging', 'forge-json'), trafficCapability('upstream')]), 'traffic-upstream-logging'), 'full-config'), source: 'forge-traffic-limiting-output'});
  fixtures.push({...await materializeComposition(root, 'upstream-site-fragment-bundle', compose(compositionRequest(version, [balancedProxy, roundRobin], 'site-fragment'), 'upstream-site-fragment-bundle'), 'site-fragment'), source: 'forge-upstream-output'});

  const sharedUpstreamSites = [
    {id: 'balanced-alpha', capabilities: [upstreamProxy('balanced-alpha.example.com'), roundRobin]},
    {id: 'balanced-bravo', capabilities: [upstreamProxy('balanced-bravo.example.com'), roundRobin]},
  ];
  const sharedUpstream = composeSites(multiRequest(version, sharedUpstreamSites), 'multi-shared-upstream');
  assert.equal((sharedUpstream.artifacts[0].content.match(/upstream forge_app_pool/g) ?? []).length, 1, 'shared upstream must be emitted once');
  fixtures.push({...await materializeComposition(root, 'multi-shared-upstream', sharedUpstream, 'full-config'), source: 'forge-upstream-output'});
  const distinctUpstreamSites = [
    {id: 'pool-alpha', capabilities: [upstreamProxy('pool-alpha.example.com', 'alpha-pool'), upstreamCapability('alpha-pool')]},
    {id: 'pool-bravo', capabilities: [upstreamProxy('pool-bravo.example.com', 'bravo-pool'), upstreamCapability('bravo-pool')]},
  ];
  fixtures.push({...await materializeComposition(root, 'multi-distinct-upstreams', composeSites(multiRequest(version, distinctUpstreamSites), 'multi-distinct-upstreams'), 'full-config'), source: 'forge-upstream-output'});
  fixtures.push({...await materializeComposition(root, 'static-and-balanced-proxy', composeSites(multiRequest(version, [multiStaticSites[0], sharedUpstreamSites[0]]), 'static-and-balanced-proxy'), 'full-config'), source: 'forge-upstream-output'});

  const loggedSites = [
    nativeSite('logged-alpha', 'logged-alpha.example.com', 4501, [loggingCapability('logged-alpha', 'forge-json')]),
    nativeSite('logged-bravo', 'logged-bravo.example.com', 4502, [loggingCapability('logged-bravo', 'forge-json', 'emerg')]),
    nativeSite('logged-charlie', 'logged-charlie.example.com', 4503, [loggingCapability('logged-charlie', 'combined')]),
  ];
  const multiLogging = composeSites(multiRequest(version, loggedSites), 'multi-logging');
  assert.equal((multiLogging.artifacts[0].content.match(/log_format forge_json_v1/g) ?? []).length, 1, 'shared JSON log format must be emitted once');
  fixtures.push({...await materializeComposition(root, 'multi-logging', multiLogging, 'full-config'), source: 'forge-logging-output'});
  fixtures.push({...await materializeComposition(root, 'logging-site-fragment-bundle', composeSites(multiRequest(version, loggedSites, 'site-fragment'), 'logging-site-fragment-bundle'), 'site-fragment'), source: 'forge-logging-output'});

  const sharedTrafficSites = [
    nativeSite('traffic-alpha', 'traffic-alpha.example.com', 4601, [trafficCapability('shared-edge')]),
    nativeSite('traffic-bravo', 'traffic-bravo.example.com', 4602, [trafficCapability('shared-edge')]),
  ];
  const sharedTraffic = composeSites(multiRequest(version, sharedTrafficSites), 'multi-shared-traffic');
  assert.equal((sharedTraffic.artifacts[0].content.match(/limit_req_zone .*forge_req_shared_edge/g) ?? []).length, 1, 'shared request zone must be emitted once');
  fixtures.push({...await materializeComposition(root, 'multi-shared-traffic', sharedTraffic, 'full-config'), source: 'forge-traffic-limiting-output'});
  const independentTrafficSites = [
    nativeSite('traffic-one', 'traffic-one.example.com', 4611, [trafficCapability('policy-one')]),
    nativeSite('traffic-two', 'traffic-two.example.com', 4612, [trafficCapability('policy-two')]),
  ];
  fixtures.push({...await materializeComposition(root, 'multi-independent-traffic', composeSites(multiRequest(version, independentTrafficSites), 'multi-independent-traffic'), 'full-config'), source: 'forge-traffic-limiting-output'});
  fixtures.push({...await materializeComposition(root, 'traffic-site-fragment-bundle', composeSites(multiRequest(version, sharedTrafficSites, 'site-fragment'), 'traffic-site-fragment-bundle'), 'site-fragment'), source: 'forge-traffic-limiting-output'});
  const trafficOrderA = composeSites(multiRequest(version, [...independentTrafficSites].reverse()), 'traffic-order-a');
  const trafficOrderB = composeSites(multiRequest(version, independentTrafficSites), 'traffic-order-b');
  assert.deepEqual(trafficOrderA.artifacts, trafficOrderB.artifacts, 'Equivalent traffic-limiting site orders must emit byte-identical artifacts');
  fixtures.push({...await materializeComposition(root, 'traffic-site-order-determinism', trafficOrderA, 'full-config'), source: 'forge-traffic-limiting-output', equivalentSelectionOrderVerified: true});

  const missingUpstream = composeNginxCapabilities(compositionRequest(version, [balancedProxy]));
  assert.equal(missingUpstream.ok, false, 'Forge must reject unresolved upstream references');
  const unsafeUpstream = composeNginxCapabilities(compositionRequest(version, [balancedProxy, upstreamCapability('app-pool', 'round-robin', [{host: '127.0.0.1;include', port: 4101}, {host: '127.0.0.1', port: 4102}])]));
  assert.equal(unsafeUpstream.ok, false, 'Forge must reject unsafe backend addresses');
  const unsupportedStrategy = composeNginxCapabilities(compositionRequest(version, [balancedProxy, {...roundRobin, input: {...roundRobin.input, strategy: 'random'}}]));
  assert.equal(unsupportedStrategy.ok, false, 'Forge must reject unsupported balancing strategies');
  const contradictoryUpstreams = composeNginxSites(multiRequest(version, [
    sharedUpstreamSites[0],
    {id: 'balanced-conflict', capabilities: [upstreamProxy('balanced-conflict.example.com'), upstreamCapability('app-pool', 'round-robin', [{host: '127.0.0.1', port: 4301}, {host: '127.0.0.1', port: 4302}])]},
  ]));
  assert.equal(contradictoryUpstreams.ok, false, 'Forge must reject contradictory shared upstream definitions');
  const unsafeLogPath = composeNginxCapabilities(compositionRequest(version, [proxy, {id: 'logging', input: {accessLog: 'combined', accessLogPath: '/tmp/../escape.log', errorLogPath: '/tmp/error.log'}}]));
  assert.equal(unsafeLogPath.ok, false, 'Forge must reject traversal in log paths');
  const unsafeLogVariable = composeNginxCapabilities(compositionRequest(version, [proxy, {id: 'logging', input: {accessLog: 'combined', accessLogPath: '/tmp/$host.log', errorLogPath: '/tmp/error.log'}}]));
  assert.equal(unsafeLogVariable.ok, false, 'Forge must reject variables in log paths');
  const unsupportedLogLevel = composeNginxCapabilities(compositionRequest(version, [proxy, {id: 'logging', input: {accessLog: 'off', errorLogPath: '/tmp/error.log', errorLogLevel: 'debug'}}]));
  assert.equal(unsupportedLogLevel.ok, false, 'Forge must reject unsupported debug logging');
  const unsafeTrafficKey = composeNginxCapabilities(compositionRequest(version, [proxy, {id: 'traffic-limiting', input: {policyId: 'unsafe', requestLimit: {rate: 1, key: '$http_x_forwarded_for'}}}]));
  assert.equal(unsafeTrafficKey.ok, false, 'Forge must reject arbitrary client identity expressions');
  const unsafeTrafficId = composeNginxCapabilities(compositionRequest(version, [proxy, {id: 'traffic-limiting', input: {policyId: 'bad;include', requestLimit: {rate: 1}}}]));
  assert.equal(unsafeTrafficId.ok, false, 'Forge must reject unsafe traffic policy identities');
  const invalidTrafficBounds = composeNginxCapabilities(compositionRequest(version, [proxy, {id: 'traffic-limiting', input: {policyId: 'bounds', requestLimit: {rate: 0, zoneSizeMb: 64}}}]));
  assert.equal(invalidTrafficBounds.ok, false, 'Forge must reject invalid rate and zone bounds');
  const contradictoryTraffic = composeNginxSites(multiRequest(version, [
    nativeSite('traffic-conflict-a', 'traffic-conflict-a.example.com', 4621, [trafficCapability('conflict', {connectionLimit: undefined, requestLimit: {rate: 10}})]),
    nativeSite('traffic-conflict-b', 'traffic-conflict-b.example.com', 4622, [trafficCapability('conflict', {connectionLimit: undefined, requestLimit: {rate: 20}})]),
  ]));
  assert.equal(contradictoryTraffic.ok, false, 'Forge must reject contradictory shared traffic zones');

  const duplicate = composeNginxSites(multiRequest(version, [nativeSite('one', 'duplicate.example.com', 3501), nativeSite('two', 'duplicate.example.com', 3502)]));
  assert.equal(duplicate.ok, false, 'Forge must reject duplicate listener/server-name ownership');
  assert.ok(duplicate.diagnostics.some(item => item.code === 'composition.server.conflict'));
  const unsupported = composeNginxSites(multiRequest(version, [nativeSite('wildcard', '*.example.com', 3503)]));
  assert.equal(unsupported.ok, false, 'Forge must reject unsupported wildcard server names');
  const unsafeStaticRoot = composeNginxCapabilities(compositionRequest(version, [staticCapability('unsafe-root.example.com', '/fixtures/../secret')]));
  assert.equal(unsafeStaticRoot.ok, false, 'Forge must reject traversal in a static document root');
  const unsafeStaticIndex = composeNginxCapabilities(compositionRequest(version, [{id: 'static-site', input: {domain: 'unsafe-index.example.com', documentRoot: '/fixtures/shared/static-standard', indexFile: '../index.html', spaFallback: false}}]));
  assert.equal(unsafeStaticIndex.ok, false, 'Forge must reject traversal in a static index filename');
  const staticProxyConflict = composeNginxCapabilities(compositionRequest(version, [staticCapability('app.example.com', '/fixtures/shared/static-standard'), proxy]));
  assert.equal(staticProxyConflict.ok, false, 'Forge must reject static and proxy ownership of the root location');
  const staticWebSocketConflict = composeNginxCapabilities(compositionRequest(version, [staticCapability('app.example.com', '/fixtures/shared/static-standard', true), proxy, websocketRoot]));
  assert.equal(staticWebSocketConflict.ok, false, 'Forge must reject SPA fallback combined with proxy/WebSocket root ownership');
  return {fixtures, generated: new Map(fixtures.map(item => [item.name, item])), policy: {
    duplicateListenerNameRejected: true,
    wildcardHostRejected: true,
    unsafeStaticRootRejected: true,
    unsafeStaticIndexRejected: true,
    staticProxyRootConflictRejected: true,
    staticWebSocketConflictRejected: true,
    missingUpstreamRejected: true,
    unsafeUpstreamRejected: true,
    unsupportedUpstreamStrategyRejected: true,
    contradictorySharedUpstreamRejected: true,
    unsafeLogPathRejected: true,
    unsafeLogVariableRejected: true,
    unsupportedLogLevelRejected: true,
    unsafeTrafficKeyRejected: true,
    unsafeTrafficIdentityRejected: true,
    invalidTrafficBoundsRejected: true,
    contradictorySharedTrafficZoneRejected: true,
  }};
}

async function materializeComposition(root, name, result, profile) {
  const directory = join(root, name);
  await mkdir(directory, {recursive: true});
  for (const output of result.artifacts) await writeFile(join(directory, output.filename), output.content, {encoding: 'utf8', mode: 0o600});
  if (profile === 'site-fragment') {
    const wrapper = `events {}\nhttp {\n  include /fixtures/${name}/http-shared.conf;\n  include /fixtures/${name}/site.conf;\n}\n`;
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
    {
      name: 'malformed-static-try-files', source: 'static-website',
      mutate: content => content.replace('try_files $uri $uri/ =404;', 'try_files;'),
      expected: ['invalid number of arguments in "try_files" directive'],
    },
    {
      name: 'duplicate-static-root', source: 'static-website',
      mutate: content => content.replace('root /fixtures/shared/static-standard;', 'root /fixtures/shared/static-standard;\n        root /fixtures/shared/static-spa;'),
      expected: ['"root" directive is duplicate'],
    },
    {
      name: 'invalid-upstream-parameter', source: 'upstream-weighted-round-robin',
      mutate: content => content.replace('weight=3', 'weight=0'),
      expected: ['invalid parameter "weight=0"'],
    },
    {
      name: 'invalid-least-conn-context', source: 'upstream-least-connections',
      mutate: content => content.replace('least_conn;', '').replace('location / {', 'location / {\n            least_conn;'),
      expected: ['"least_conn" directive is not allowed here'],
    },
    {
      name: 'duplicate-upstream-name', source: 'upstream-weighted-round-robin',
      mutate: content => content.replace('    server {', '    upstream forge_app_pool { server 127.0.0.1:4999; }\n\n    server {'),
      expected: ['duplicate upstream "forge_app_pool"'],
    },
    {
      name: 'invalid-access-log-context', source: 'logging-combined',
      mutate: content => content.replace('events {', 'events {\n    access_log /tmp/invalid.access.log combined;'),
      expected: ['"access_log" directive is not allowed here'],
    },
    {
      name: 'invalid-error-log-level', source: 'logging-combined',
      mutate: content => content.replace('error_log /tmp/logging-combined.error.log warn;', 'error_log /tmp/logging-combined.error.log verbose;'),
      expected: ['invalid log level'],
    },
    {
      name: 'unknown-access-log-format', source: 'logging-json',
      mutate: content => content.replace('forge_json_v1;', 'missing_format;'),
      expected: ['unknown log format "missing_format"'],
    },
    {
      name: 'malformed-log-format', source: 'logging-json',
      mutate: content => content.replace('log_format forge_json_v1 escape=json', 'log_format'),
      expected: ['invalid number of arguments in "log_format" directive'],
    },
    {
      name: 'duplicate-log-format-name', source: 'logging-json',
      mutate: content => content.replace('    server {', '    log_format forge_json_v1 escape=json \'duplicate\';\n\n    server {'),
      expected: ['duplicate "log_format" name "forge_json_v1"'],
    },
    {
      name: 'missing-request-zone-definition', source: 'traffic-request-only',
      mutate: content => content.replace('    limit_req_zone $binary_remote_addr zone=forge_req_request_only:4m rate=5r/s;\n', ''),
      expected: ['zero size shared memory zone "forge_req_request_only"'],
    },
    {
      name: 'missing-connection-zone-definition', source: 'traffic-connection-only',
      mutate: content => content.replace('    limit_conn_zone $binary_remote_addr zone=forge_conn_connection_only:4m;\n', ''),
      expected: ['zero size shared memory zone "forge_conn_connection_only"'],
    },
    {
      name: 'invalid-request-zone-size', source: 'traffic-request-only',
      mutate: content => content.replace('zone=forge_req_request_only:4m', 'zone=forge_req_request_only:0m'),
      expected: ['zone "zone=forge_req_request_only:0m" is too small'],
    },
    {
      name: 'invalid-request-rate', source: 'traffic-request-only',
      mutate: content => content.replace('rate=5r/s', 'rate=0r/s'),
      expected: ['invalid rate "rate=0r/s"'],
    },
    {
      name: 'invalid-request-burst', source: 'traffic-both-custom',
      mutate: content => content.replace('burst=15', 'burst=0'),
      expected: ['invalid burst value "burst=0"'],
    },
    {
      name: 'invalid-request-limit-status', source: 'traffic-request-only',
      mutate: content => content.replace('limit_req_status 429;', 'limit_req_status 399;'),
      expected: ['value must be between 400 and 599'],
    },
    {
      name: 'invalid-connection-limit-status', source: 'traffic-connection-only',
      mutate: content => content.replace('limit_conn_status 503;', 'limit_conn_status 600;'),
      expected: ['value must be between 400 and 599'],
    },
    {
      name: 'invalid-connection-limit', source: 'traffic-connection-only',
      mutate: content => content.replace('limit_conn forge_conn_connection_only 12;', 'limit_conn forge_conn_connection_only 0;'),
      expected: ['invalid number of connections "0"'],
    },
    {
      name: 'illegal-request-zone-context', source: 'traffic-request-only',
      mutate: content => content.replace('events {', 'events {\n    limit_req_zone $binary_remote_addr zone=forge_req_illegal:1m rate=1r/s;'),
      expected: ['"limit_req_zone" directive is not allowed here'],
    },
    {
      name: 'duplicate-conflicting-request-zone', source: 'traffic-request-only',
      mutate: content => content.replace('    limit_req_zone $binary_remote_addr zone=forge_req_request_only:4m rate=5r/s;', '    limit_req_zone $binary_remote_addr zone=forge_req_request_only:4m rate=5r/s;\n    limit_req_zone $binary_remote_addr zone=forge_req_request_only:8m rate=5r/s;'),
      expected: ['conflicts with already declared size'],
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
    {id: 'http_log', verified: !hasFlag('--without-http_log_module'), evidence: 'no --without-http_log_module configure flag'},
    {id: 'http_limit_req', verified: !hasFlag('--without-http_limit_req_module'), evidence: 'no --without-http_limit_req_module configure flag'},
    {id: 'http_limit_conn', verified: !hasFlag('--without-http_limit_conn_module'), evidence: 'no --without-http_limit_conn_module configure flag'},
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
    '-t', '-e', 'stderr', '-g', 'pid /tmp/nginx.pid;', '-p', `/fixtures/${relative}/`, '-c', `/fixtures/${relative}/nginx.conf`];
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

async function materializePolicyWarning(root, generated) {
  const sourceFixture = generated.get('multi-http-sites');
  const original = await readFile(sourceFixture.config, 'utf8');
  const content = original.replace('server_name bravo.example.com;', 'server_name alpha.example.com;');
  assert.notEqual(content, original, 'policy warning fixture did not create a duplicate server name');
  const directory = join(root, 'nginx-warning-forge-policy-rejects');
  await mkdir(directory, {recursive: true});
  const config = join(directory, 'nginx.conf');
  await writeFile(config, content, {encoding: 'utf8', mode: 0o600});
  return {name: 'nginx-warning-forge-policy-rejects', directory, config, profile: 'deliberately-ambiguous-mutation', source: 'warning mutation of multi-http-sites', expected: ['conflicting server name']};
}

async function materializeParserAcceptedPolicyRejection(root, generated) {
  const sourceFixture = generated.get('multi-websocket-sites');
  const original = await readFile(sourceFixture.config, 'utf8');
  const content = original.replace('    server {', '    map $http_upgrade $connection_upgrade {\n        default close;\n    }\n\n    server {');
  assert.notEqual(content, original, 'shared-resource policy fixture did not create a contradictory duplicate map');
  const directory = join(root, 'parser-accepts-forge-shared-conflict');
  await mkdir(directory, {recursive: true});
  const config = join(directory, 'nginx.conf');
  await writeFile(config, content, {encoding: 'utf8', mode: 0o600});
  return {name: 'parser-accepts-forge-shared-conflict', directory, config, profile: 'deliberately-contradictory-mutation', source: 'policy mutation of multi-websocket-sites'};
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Native Nginx validation is confined to an explicitly invoked Linux test environment.');
  const options = parseArguments(process.argv.slice(2));
  await mkdir(dirname(options.report), {recursive: true});
  const root = await mkdtemp(join(tmpdir(), 'forge-nginx-native-'));
  const report = {schemaVersion: '1.1', image: options.image, isolation: {network: 'none', readOnlyRoot: true, capabilities: 'all-dropped', noNewPrivileges: true, containerUser: `${process.getuid()}:${process.getgid()}`, timeoutMs: PROCESS_TIMEOUT_MS}, positive: [], negative: [], policyWarnings: [], parserAcceptedPolicyRejections: []};
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
    const secondCertificate = await runProcess('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(shared, 'key-two.pem'), '-out', join(shared, 'cert-two.pem'), '-subj', '/CN=bravo-tls.example.com']);
    requireSuccess(secondCertificate, 'Second disposable certificate generation');
    for (const name of ['static-standard', 'static-spa']) {
      const directory = join(shared, name);
      await mkdir(directory, {recursive: true});
      await writeFile(join(directory, 'index.html'), `<!doctype html><title>${name}</title>\n`, {encoding: 'utf8', mode: 0o600});
      await writeFile(join(directory, 'app.js'), 'globalThis.forgeStaticFixture = true;\n', {encoding: 'utf8', mode: 0o600});
    }

    const {fixtures: positive, generated, policy} = await materializePositive(root, options.expectedVersion);
    report.forgePolicy = policy;
    const negative = await materializeNegative(root, generated);
    const policyWarning = await materializePolicyWarning(root, generated);
    const parserAcceptedPolicyRejection = await materializeParserAcceptedPolicyRejection(root, generated);
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
    const warningResult = await runNginx(options.image, root, policyWarning);
    report.policyWarnings.push({...evidence(policyWarning, warningResult), expectedFragments: policyWarning.expected, forgePolicy: 'rejected before serialization'});
    requireSuccess(warningResult, 'Nginx warning fixture accepted by parser');
    const warningOutput = `${warningResult.stderr}\n${warningResult.stdout}`.toLowerCase();
    for (const fragment of policyWarning.expected) assert.ok(warningOutput.includes(fragment), `Policy warning fixture did not emit: ${fragment}\n${warningResult.stderr}`);
    const acceptedResult = await runNginx(options.image, root, parserAcceptedPolicyRejection);
    report.parserAcceptedPolicyRejections.push({...evidence(parserAcceptedPolicyRejection, acceptedResult), forgePolicy: 'contradictory semantic shared resource rejected before serialization'});
    requireSuccess(acceptedResult, 'Parser-accepted contradictory shared-resource fixture');
    report.status = 'passed';
    console.log(`Native Nginx validation passed: ${positive.length} positive, ${negative.length} negative, 1 parser-warning/policy rejection, and 1 parser-accepted/Forge-rejected fixture on ${report.nginxVersionOutput}.`);
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
