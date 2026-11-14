import assert from 'node:assert/strict';
import test from 'node:test';

import {composeNginxSites} from '../dist/nginx-composition/index.js';
import {
  buildNginxStudioRequest,
  createDefaultNginxStudioState,
  createNginxRoute,
  createNginxSite,
  diagnosticTarget,
  nginxControlId,
} from '../dist/ui/nginx-studio.js';

test('Studio defaults map to the existing typed reverse-proxy engine', () => {
  const state = createDefaultNginxStudioState();
  const first = buildNginxStudioRequest(state);
  const second = buildNginxStudioRequest(structuredClone(state));
  assert.deepEqual(first.request, second.request);
  assert.deepEqual(first.request.sites[0].capabilities.map(item => item.id), ['reverse-proxy']);
  const outcome = composeNginxSites(first.request);
  assert.equal(outcome.ok, true);
  assert.match(outcome.artifacts[0].content, /server_name app\.example\.com;/u);
});

test('advanced Studio state composes every supported capability across multiple sites', () => {
  const state = createDefaultNginxStudioState();
  state.mode = 'advanced';
  const proxy = state.sites[0];
  proxy.useUpstream = true;
  proxy.upstreamStrategy = 'least-connections';
  proxy.backends[0].weight = '3';
  proxy.backends[0].maxFails = '2';
  proxy.backends[0].failTimeoutSeconds = '30';
  const route = createNginxRoute('route-api');
  route.websocket = true;
  proxy.routes.push(route);
  proxy.rootWebsocket = true;
  proxy.logging = true;
  proxy.accessLog = 'forge-json';
  proxy.requestLimit = true;
  proxy.connectionLimit = true;
  const staticSite = createNginxSite('site-static', 2);
  staticSite.workflow = 'static-site';
  staticSite.spaFallback = true;
  state.sites.push(staticSite);

  const built = buildNginxStudioRequest(state);
  assert.deepEqual(built.request.sites[0].capabilities.map(item => item.id), [
    'reverse-proxy', 'upstream-load-balancing', 'routing', 'websocket', 'logging', 'traffic-limiting',
  ]);
  assert.deepEqual(built.request.sites[1].capabilities.map(item => item.id), ['static-site']);
  const outcome = composeNginxSites(built.request);
  assert.equal(outcome.ok, true, JSON.stringify(outcome.diagnostics));
  const output = outcome.artifacts.map(item => item.content).join('\n');
  assert.match(output, /least_conn;/u);
  assert.match(output, /weight=3 max_fails=2 fail_timeout=30s/u);
  assert.match(output, /map \$http_upgrade \$connection_upgrade/u);
  assert.match(output, /log_format forge_json/u);
  assert.match(output, /limit_req_zone/u);
  assert.match(output, /try_files \$uri \$uri\/ \/index\.html;/u);
});

test('Studio does not interpret malicious values and maps rejection to the exact control', () => {
  const state = createDefaultNginxStudioState();
  state.sites[0].domain = 'safe.example.com; include /tmp/payload';
  const built = buildNginxStudioRequest(state);
  assert.equal(built.request.sites[0].capabilities[0].input.domain, state.sites[0].domain);
  const outcome = composeNginxSites(built.request);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.artifacts, []);
  const domainDiagnostic = outcome.diagnostics.find(item => item.path?.endsWith('.domain'));
  assert.ok(domainDiagnostic);
  assert.equal(diagnosticTarget(domainDiagnostic.path, built.diagnosticTargets), nginxControlId(state.sites[0].key, 'domain'));
});

test('nested backend diagnostics resolve to stable dynamic editor controls', () => {
  const state = createDefaultNginxStudioState();
  state.sites[0].useUpstream = true;
  state.sites[0].backends[1].host = '127.0.0.1; return 200';
  const built = buildNginxStudioRequest(state);
  const outcome = composeNginxSites(built.request);
  assert.equal(outcome.ok, false);
  const diagnostic = outcome.diagnostics.find(item => item.path?.includes('backends[1].targetHost'));
  assert.ok(diagnostic);
  assert.equal(diagnosticTarget(diagnostic.path, built.diagnosticTargets), nginxControlId(state.sites[0].backends[1].key, 'host'));
});
