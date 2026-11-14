import {outcomes} from './generators/index.js';
import {composeNginxSites} from './nginx-composition/index.js';
import type {Diagnostic, GenerationOutcome, OutputArtifact, ValidationRecord, ValidationSummary} from './core/types.js';
import type {NginxCompositionOutcome} from './nginx-composition/types.js';
import {
  buildNginxStudioRequest,
  createDefaultNginxStudioState,
  createNginxBackend,
  createNginxRoute,
  createNginxSite,
  diagnosticTarget,
  nginxControlId,
  NGINX_STUDIO_LIMITS,
  NGINX_STUDIO_TARGET_MODULES,
  NGINX_STUDIO_TARGET_VERSION,
} from './ui/nginx-studio.js';
import type {NginxStudioBackend, NginxStudioRoute, NginxStudioSite} from './ui/nginx-studio.js';
import {createZipBlob} from './ui/zip.js';

type GeneratorId = 'nginx' | 'compose' | 'systemd';
type FieldValue = string | boolean;
type UiResult = GenerationOutcome | NginxCompositionOutcome;

interface FieldOption { readonly value: string; readonly label: string; }
interface FieldDefinition {
  readonly id: string;
  readonly label: string;
  readonly type: 'text' | 'number' | 'checkbox' | 'select';
  readonly description: string;
  readonly group: string;
  readonly placeholder?: string;
  readonly options?: readonly FieldOption[];
  readonly visible?: (values: Readonly<Record<string, FieldValue>>) => boolean;
}
interface GeneratorDefinition {
  readonly label: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly fields: readonly FieldDefinition[];
}

const applicationRoot = document.getElementById('app');
if (applicationRoot === null) throw new Error('Missing application root.');
const app: HTMLElement = applicationRoot;

const githubUrl = 'https://github.com/cyberdr1ft3r/Forge';
const docsUrl = `${githubUrl}/blob/main/docs/ARCHITECTURE.md`;
const generatorIds: readonly GeneratorId[] = ['nginx', 'compose', 'systemd'];
const defaults: Record<GeneratorId, Record<string, FieldValue>> = {
  nginx: {},
  compose: {service: 'web', image: 'nginx:stable', hostPort: '8080', containerPort: '80', restart: 'unless-stopped'},
  systemd: {service: 'myapp', description: 'My application', user: 'appuser', workdir: '/opt/myapp', executable: '/usr/bin/node', arguments: 'server.js'},
};

const definitions: Record<GeneratorId, GeneratorDefinition> = {
  nginx: {
    label: 'Nginx', eyebrow: 'NGINX / CAPABILITY COMPOSITION', title: 'Nginx configuration',
    description: 'Compose one or more proxy and static sites from Forge’s typed capability engine, then inspect every required artifact.',
    fields: [],
  },
  compose: {
    label: 'Docker Compose', eyebrow: 'DOCKER COMPOSE / SERVICE', title: 'Docker Compose service',
    description: 'Generate a single loopback-bound container service using the existing Forge generator contract.',
    fields: [
      {id: 'service', label: 'Service name', type: 'text', group: 'Service', description: 'Compose service identifier.'},
      {id: 'image', label: 'Container image', type: 'text', group: 'Service', description: 'Use a pinned tag or digest for deployment.'},
      {id: 'hostPort', label: 'Host port', type: 'number', group: 'Networking', description: 'Loopback port exposed on the host.'},
      {id: 'containerPort', label: 'Container port', type: 'number', group: 'Networking', description: 'Port exposed by the container.'},
      {id: 'restart', label: 'Restart policy', type: 'select', group: 'Runtime', description: 'Docker Compose restart behavior.', options: ['unless-stopped', 'always', 'no', 'on-failure'].map(value => ({value, label: value}))},
    ],
  },
  systemd: {
    label: 'systemd', eyebrow: 'SYSTEMD / SERVICE UNIT', title: 'systemd service',
    description: 'Create a hardened Linux service unit using the existing Forge generator contract.',
    fields: [
      {id: 'service', label: 'Service name', type: 'text', group: 'Identity', description: 'Unit base name.'},
      {id: 'description', label: 'Description', type: 'text', group: 'Identity', description: 'Human-readable service description.'},
      {id: 'user', label: 'Linux user', type: 'text', group: 'Execution', description: 'Unprivileged account that runs the service.'},
      {id: 'workdir', label: 'Working directory', type: 'text', group: 'Execution', description: 'Absolute application directory.'},
      {id: 'executable', label: 'Executable path', type: 'text', group: 'Execution', description: 'Absolute binary path.'},
      {id: 'arguments', label: 'Arguments', type: 'text', group: 'Execution', description: 'Optional space-separated literal arguments.'},
    ],
  },
};

let selected: GeneratorId = 'nginx';
const values: Record<GeneratorId, Record<string, FieldValue>> = structuredClone(defaults);
const nginxStudio = createDefaultNginxStudioState();
let nginxCollectionSequence = 10;
let nginxDiagnosticTargets: ReadonlyMap<string, string> = new Map();
const staleResults: Record<GeneratorId, boolean> = {nginx: false, compose: false, systemd: false};
let currentResult: UiResult | null = null;
let selectedArtifactId = '';

function isGeneratorId(value: string): value is GeneratorId { return generatorIds.includes(value as GeneratorId); }
function generatorFromPath(pathname: string): GeneratorId | null {
  const match = /^\/generators\/(nginx|compose|systemd)\/?$/.exec(pathname);
  return match?.[1] !== undefined && isGeneratorId(match[1]) ? match[1] : null;
}
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function icon(id: GeneratorId): string { return id === 'nginx' ? 'N' : id === 'compose' ? 'D' : 'S'; }

function navMarkup(inWorkspace: boolean): string {
  return `<header class="site-nav">
    <a class="brand" href="/" data-route><span class="brand-mark" aria-hidden="true">◇</span><span>FORGE</span></a>
    ${inWorkspace ? `<label class="generator-switch"><span class="sr-only">Active generator</span><select id="generator-switch">${generatorIds.map(id => `<option value="${id}"${id === selected ? ' selected' : ''}>Generators / ${definitions[id].label}</option>`).join('')}</select></label>` : ''}
    <nav aria-label="Primary navigation">
      ${inWorkspace ? `<a href="/generators/${selected}" data-route>Workspace</a>` : '<a href="#generators">Generators</a>'}
      <a href="${docsUrl}" target="_blank" rel="noreferrer">Docs</a><a href="${githubUrl}" target="_blank" rel="noreferrer">GitHub</a>
    </nav>
  </header>`;
}

function renderLanding(): void {
  document.title = 'Forge — Configuration Studio';
  app.innerHTML = `${navMarkup(false)}
    <main id="main-content" class="landing" tabindex="-1">
      <section class="hero" aria-labelledby="hero-title">
        <p class="overline">LOCAL-FIRST CONFIGURATION STUDIO</p><h1 id="hero-title">Infrastructure configs,<br><span>composed with intent.</span></h1>
        <p class="hero-copy">Forge turns guided inputs into deterministic Nginx, Docker Compose, and systemd configuration files. Review every artifact and validate it with the native tool before deployment.</p>
        <div class="hero-actions"><a class="button button-primary" href="/generators/nginx" data-route>Start generating <span aria-hidden="true">→</span></a><a class="button button-secondary" href="${githubUrl}" target="_blank" rel="noreferrer">View on GitHub</a></div>
        <p class="local-note"><span aria-hidden="true">●</span> Generation stays in your browser. No credentials, deployment, or telemetry.</p>
      </section>
      <section id="generators" class="generator-section" aria-labelledby="generator-title">
        <div class="section-intro"><p class="overline">SUPPORTED GENERATORS</p><h2 id="generator-title">Choose a configuration workflow</h2><p>Each generator uses strict typed input and keeps native validation status honest.</p></div>
        <div class="generator-cards">${generatorIds.map(id => `<a class="generator-card" href="/generators/${id}" data-route><span class="card-icon" aria-hidden="true">${icon(id)}</span><span class="card-status">Available</span><h3>${definitions[id].label}</h3><p>${id === 'nginx' ? 'Multi-site proxy, routing, upstreams, logging, limiting, static site, and SPA workflows.' : id === 'compose' ? 'A secure loopback-bound single-service Compose file.' : 'A hardened service unit for a Linux application.'}</p><span class="card-link">Open generator <span aria-hidden="true">→</span></span></a>`).join('')}</div>
      </section>
      <section class="cli-callout" aria-labelledby="cli-title"><div><p class="overline">FORGE CLI</p><h2 id="cli-title">Command-line workflow</h2><p>A Forge CLI is planned, but it is not part of the current browser release scope.</p></div><span class="coming-soon">Coming later</span></section>
    </main><footer class="site-footer"><span>Forge · local-first configuration studio</span><span>Review and natively validate every output before use.</span></footer>`;
  bindRoutes();
}

function fieldMarkup(field: FieldDefinition, fieldValues: Readonly<Record<string, FieldValue>>): string {
  if (field.visible !== undefined && !field.visible(fieldValues)) return '';
  const rawValue = fieldValues[field.id] ?? '';
  const errorId = `${field.id}-error`;
  if (field.type === 'checkbox') return `<div class="field field-checkbox" data-field-wrap="${field.id}"><label for="${field.id}"><input id="${field.id}" name="${field.id}" type="checkbox"${rawValue === true ? ' checked' : ''}><span><strong>${field.label}</strong><small>${field.description}</small></span></label><p class="field-error" id="${errorId}"></p></div>`;
  const control = field.type === 'select'
    ? `<select id="${field.id}" name="${field.id}" aria-describedby="${field.id}-help ${errorId}">${(field.options ?? []).map(option => `<option value="${escapeHtml(option.value)}"${rawValue === option.value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`
    : `<input id="${field.id}" name="${field.id}" type="${field.type}" value="${escapeHtml(String(rawValue))}"${field.placeholder === undefined ? '' : ` placeholder="${escapeHtml(field.placeholder)}"`} aria-describedby="${field.id}-help ${errorId}">`;
  return `<div class="field" data-field-wrap="${field.id}"><label for="${field.id}">${field.label}</label>${control}<small id="${field.id}-help">${field.description}</small><p class="field-error" id="${errorId}"></p></div>`;
}
function fieldsMarkup(definition: GeneratorDefinition, fieldValues: Readonly<Record<string, FieldValue>>): string {
  const visible = definition.fields.filter(field => field.visible === undefined || field.visible(fieldValues));
  const groups = [...new Set(visible.map(field => field.group))];
  return groups.map((group, index) => `<fieldset><legend><span>${String(index + 1).padStart(2, '0')}</span>${group}</legend><div class="field-grid">${visible.filter(field => field.group === group).map(field => fieldMarkup(field, fieldValues)).join('')}</div></fieldset>`).join('');
}

function nginxControlAttributes(scope: 'root' | 'site' | 'route' | 'backend', key: string, field: string): string {
  return `data-nginx-control data-nginx-scope="${scope}" data-nginx-key="${escapeHtml(key)}" data-nginx-field="${field}"`;
}

function nginxInput(scope: 'root' | 'site' | 'route' | 'backend', key: string, field: string, label: string, value: string, description: string, type: 'text' | 'number' = 'text'): string {
  const id = nginxControlId(key, field);
  return `<div class="field" data-field-wrap="${id}"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${escapeHtml(value)}" ${nginxControlAttributes(scope, key, field)} aria-describedby="${id}-help ${id}-error"><small id="${id}-help">${description}</small><p class="field-error" id="${id}-error"></p></div>`;
}

function nginxSelect(scope: 'root' | 'site' | 'route' | 'backend', key: string, field: string, label: string, value: string, description: string, options: readonly FieldOption[]): string {
  const id = nginxControlId(key, field);
  return `<div class="field" data-field-wrap="${id}"><label for="${id}">${label}</label><select id="${id}" ${nginxControlAttributes(scope, key, field)} aria-describedby="${id}-help ${id}-error">${options.map(option => `<option value="${escapeHtml(option.value)}"${option.value === value ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select><small id="${id}-help">${description}</small><p class="field-error" id="${id}-error"></p></div>`;
}

function nginxCheckbox(scope: 'site' | 'route' | 'backend', key: string, field: string, label: string, checked: boolean, description: string): string {
  const id = nginxControlId(key, field);
  return `<div class="field field-checkbox" data-field-wrap="${id}"><label for="${id}"><input id="${id}" type="checkbox" ${nginxControlAttributes(scope, key, field)}${checked ? ' checked' : ''}><span><strong>${label}</strong><small>${description}</small></span></label><p class="field-error" id="${id}-error"></p></div>`;
}

function nginxRouteMarkup(site: NginxStudioSite, route: NginxStudioRoute, index: number): string {
  return `<article class="collection-item" data-route-key="${escapeHtml(route.key)}"><header><div><span class="item-index">Route ${index + 1}</span><strong>${escapeHtml(route.prefix)}</strong></div><button type="button" class="button-danger" data-nginx-action="remove-route" data-site-key="${escapeHtml(site.key)}" data-item-key="${escapeHtml(route.key)}" aria-label="Remove route ${index + 1}">Remove</button></header><div class="field-grid">
    ${nginxInput('route', route.key, 'prefix', 'Location prefix', route.prefix, 'Literal location prefix such as /api/.')}
    ${nginxSelect('route', route.key, 'forwarding', 'URI forwarding', route.forwarding, 'Preserve or strip the matched prefix.', [{value: 'preserve-prefix', label: 'Preserve prefix'}, {value: 'strip-prefix', label: 'Strip prefix'}])}
    ${nginxInput('route', route.key, 'targetHost', 'Target host', route.targetHost, 'Literal hostname or IP for this route.')}
    ${nginxInput('route', route.key, 'targetPort', 'Target port', route.targetPort, 'TCP port from 1 to 65535.', 'number')}
    ${nginxCheckbox('route', route.key, 'websocket', 'Enable WebSocket upgrade', route.websocket, 'Apply the trusted upgrade map to this exact route.')}
  </div></article>`;
}

function nginxBackendMarkup(site: NginxStudioSite, backend: NginxStudioBackend, index: number): string {
  const canRemove = site.backends.length > 2;
  return `<article class="collection-item" data-backend-key="${escapeHtml(backend.key)}"><header><div><span class="item-index">Backend ${index + 1}</span><strong>${escapeHtml(backend.host)}:${escapeHtml(backend.port)}</strong></div><button type="button" class="button-danger" data-nginx-action="remove-backend" data-site-key="${escapeHtml(site.key)}" data-item-key="${escapeHtml(backend.key)}"${canRemove ? '' : ' disabled'} aria-label="Remove backend ${index + 1}">Remove</button></header><div class="field-grid compact-grid">
    ${nginxInput('backend', backend.key, 'host', 'Backend host', backend.host, 'Literal hostname or IP.')}
    ${nginxInput('backend', backend.key, 'port', 'Port', backend.port, 'TCP port from 1 to 65535.', 'number')}
    ${nginxInput('backend', backend.key, 'weight', 'Weight', backend.weight, 'Weighted round-robin or least-connections weight, 1–100.', 'number')}
    ${nginxInput('backend', backend.key, 'maxFails', 'Maximum failures', backend.maxFails, 'Passive failure threshold, 0–10.', 'number')}
    ${nginxInput('backend', backend.key, 'failTimeoutSeconds', 'Failure timeout (seconds)', backend.failTimeoutSeconds, 'Passive failure window, 1–300 seconds.', 'number')}
    ${nginxCheckbox('backend', backend.key, 'backup', 'Backup server', backend.backup, 'Use only when primary servers are unavailable.')}
    ${nginxCheckbox('backend', backend.key, 'down', 'Mark server down', backend.down, 'Keep this backend disabled in the generated group.')}
  </div></article>`;
}

function nginxAdvancedSiteMarkup(site: NginxStudioSite): string {
  const upstream = site.workflow === 'reverse-proxy' ? `<fieldset><legend>Upstream group</legend><div class="field-grid">
    ${nginxCheckbox('site', site.key, 'useUpstream', 'Use a load-balanced upstream group', site.useUpstream, 'Point the root proxy at two to sixteen typed backends.')}
    ${site.useUpstream ? `${nginxInput('site', site.key, 'upstreamId', 'Upstream ID', site.upstreamId, 'Stable lowercase identity for the group.')}${nginxSelect('site', site.key, 'upstreamStrategy', 'Balancing strategy', site.upstreamStrategy, 'Weighted round-robin or least-connections.', [{value: 'round-robin', label: 'Weighted round-robin'}, {value: 'least-connections', label: 'Least connections'}])}` : ''}
  </div>${site.useUpstream ? `<div class="collection-toolbar"><div><strong>Backend servers</strong><span>${site.backends.length} of ${NGINX_STUDIO_LIMITS.backendsPerUpstream}</span></div><button type="button" data-nginx-action="add-backend" data-site-key="${escapeHtml(site.key)}"${site.backends.length >= NGINX_STUDIO_LIMITS.backendsPerUpstream ? ' disabled' : ''}>+ Add backend</button></div><div class="collection-list">${site.backends.map((backend, index) => nginxBackendMarkup(site, backend, index)).join('')}</div><p class="field-error" id="${nginxControlId(site.key, 'backends')}-error"></p>` : ''}</fieldset>` : '';

  const routes = site.workflow === 'reverse-proxy' ? `<fieldset><legend>Routes & WebSocket</legend>${nginxCheckbox('site', site.key, 'rootWebsocket', 'Enable WebSocket support on /', site.rootWebsocket, 'Apply the trusted upgrade map to the root proxy location.')}<div class="collection-toolbar"><div><strong>Additional locations</strong><span>${site.routes.length} of ${NGINX_STUDIO_LIMITS.routesPerSite}</span></div><button type="button" data-nginx-action="add-route" data-site-key="${escapeHtml(site.key)}"${site.routes.length >= NGINX_STUDIO_LIMITS.routesPerSite ? ' disabled' : ''}>+ Add route</button></div><div class="collection-list">${site.routes.map((route, index) => nginxRouteMarkup(site, route, index)).join('')}</div><p class="field-error" id="${nginxControlId(site.key, 'routes')}-error"></p></fieldset>` : '';

  const logging = `<fieldset><legend>Logging</legend><div class="field-grid">${nginxCheckbox('site', site.key, 'logging', 'Configure site logging', site.logging, 'Emit explicit access and error log policy for this site.')}${site.logging ? `${nginxSelect('site', site.key, 'accessLog', 'Access-log preset', site.accessLog, 'Combined, the fixed Forge JSON format, or off.', [{value: 'combined', label: 'Combined'}, {value: 'forge-json', label: 'Forge JSON'}, {value: 'off', label: 'Off'}])}${site.accessLog === 'off' ? '' : nginxInput('site', site.key, 'accessLogPath', 'Access-log path', site.accessLogPath, 'Absolute destination; rotation remains external.')}${nginxInput('site', site.key, 'errorLogPath', 'Error-log path', site.errorLogPath, 'Absolute per-site error log destination.')}${nginxSelect('site', site.key, 'errorLogLevel', 'Error severity', site.errorLogLevel, 'Minimum emitted severity.', ['info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg'].map(value => ({value, label: value})))}` : ''}</div></fieldset>`;

  const traffic = `<fieldset><legend>Traffic limiting</legend><div class="field-grid">${nginxCheckbox('site', site.key, 'requestLimit', 'Enable per-IP request limiting', site.requestLimit, 'Leaky-bucket limit keyed only by $binary_remote_addr.')}${nginxCheckbox('site', site.key, 'connectionLimit', 'Enable per-IP connection limiting', site.connectionLimit, 'Bound concurrent Nginx request processing per client IP.')}${site.requestLimit || site.connectionLimit ? nginxInput('site', site.key, 'policyId', 'Traffic policy ID', site.policyId, 'Stable lowercase identity for engine-owned zones.') : ''}${site.requestLimit ? `${nginxInput('site', site.key, 'requestRate', 'Requests per interval', site.requestRate, 'Integer from 1 to 10,000.', 'number')}${nginxSelect('site', site.key, 'requestUnit', 'Request interval', site.requestUnit, 'Per second or minute.', [{value: 'second', label: 'Second'}, {value: 'minute', label: 'Minute'}])}${nginxInput('site', site.key, 'requestBurst', 'Burst', site.requestBurst, 'Queued burst allowance from 0 to 10,000.', 'number')}${nginxCheckbox('site', site.key, 'requestNoDelay', 'Use nodelay', site.requestNoDelay, 'Requires a positive burst.')}${nginxInput('site', site.key, 'requestZoneMb', 'Request zone (MiB)', site.requestZoneMb, 'Shared memory from 1 to 32 MiB.', 'number')}${nginxSelect('site', site.key, 'requestStatus', 'Request rejection status', site.requestStatus, '429 or 503.', [{value: '429', label: '429'}, {value: '503', label: '503'}])}` : ''}${site.connectionLimit ? `${nginxInput('site', site.key, 'connectionCount', 'Concurrent requests per IP', site.connectionCount, 'Integer from 1 to 10,000.', 'number')}${nginxInput('site', site.key, 'connectionZoneMb', 'Connection zone (MiB)', site.connectionZoneMb, 'Shared memory from 1 to 32 MiB.', 'number')}${nginxSelect('site', site.key, 'connectionStatus', 'Connection rejection status', site.connectionStatus, '429 or 503.', [{value: '429', label: '429'}, {value: '503', label: '503'}])}` : ''}</div></fieldset>`;
  const security = `<fieldset><legend>Security headers</legend><div class="field-grid">${nginxCheckbox('site', site.key, 'securityHeaders', 'Enable secure response headers', site.securityHeaders, 'Apply a fixed reviewed header preset at application-server scope.')}${site.securityHeaders ? `${nginxSelect('site', site.key, 'securityHeaderPreset', 'Security preset', site.securityHeaderPreset, 'Strict can block required application resources; test compatibility before rollout.', [{value: 'balanced', label: 'Balanced'}, {value: 'strict', label: 'Strict'}])}${nginxSelect('site', site.key, 'hstsPreset', 'HSTS policy', site.hstsPreset, 'HSTS requires HTTPS. Preload can affect every subdomain and is difficult to reverse.', [{value: 'off', label: 'Off'}, {value: 'one-year', label: 'One year + subdomains'}, {value: 'two-years-preload', label: 'Two years + preload'}])}<p class="mode-warning">Review CSP, browser-feature and HSTS compatibility before rollout. Forge presets cannot discover third-party application dependencies.</p>` : ''}</div></fieldset>`;
  const timeouts = `<fieldset><legend>Request size & timeouts</legend><div class="field-grid">${nginxCheckbox('site', site.key, 'requestTimeouts', 'Configure bounded request handling', site.requestTimeouts, 'Set explicit request-size and inactivity limits; proxy sites also receive upstream timeouts.')}${site.requestTimeouts ? `${nginxInput('site', site.key, 'clientMaxBodySizeMb', 'Maximum request body (MiB)', site.clientMaxBodySizeMb, 'Bounded from 1 to 1024 MiB.', 'number')}${nginxInput('site', site.key, 'clientBodyTimeoutSeconds', 'Client body timeout (seconds)', site.clientBodyTimeoutSeconds, 'Between successive body reads, 1–300.', 'number')}${nginxInput('site', site.key, 'clientHeaderTimeoutSeconds', 'Client header timeout (seconds)', site.clientHeaderTimeoutSeconds, 'Complete request-header timeout, 1–300.', 'number')}${nginxInput('site', site.key, 'sendTimeoutSeconds', 'Client send timeout (seconds)', site.sendTimeoutSeconds, 'Between response writes, 1–3600.', 'number')}${site.workflow === 'reverse-proxy' ? `${nginxInput('site', site.key, 'proxyConnectTimeoutSeconds', 'Proxy connect timeout (seconds)', site.proxyConnectTimeoutSeconds, 'Connection establishment, 1–75.', 'number')}${nginxInput('site', site.key, 'proxySendTimeoutSeconds', 'Proxy send timeout (seconds)', site.proxySendTimeoutSeconds, 'Between upstream request writes, 1–3600.', 'number')}${nginxInput('site', site.key, 'proxyReadTimeoutSeconds', 'Proxy read timeout (seconds)', site.proxyReadTimeoutSeconds, 'Between upstream response reads; account for SSE/WebSocket heartbeats.', 'number')}` : ''}` : ''}</div></fieldset>`;
  const compression = `<fieldset><legend>Compression</legend><div class="field-grid">${nginxCheckbox('site', site.key, 'compression', 'Enable gzip compression', site.compression, 'Use a closed MIME allowlist and bounded compression settings.')}${site.compression ? `${nginxSelect('site', site.key, 'compressionPreset', 'MIME preset', site.compressionPreset, 'text/html is always handled by Nginx when gzip is enabled.', [{value: 'web', label: 'Web assets'}, {value: 'api', label: 'API text'}, {value: 'broad', label: 'Broad text assets'}])}${nginxInput('site', site.key, 'compressionMinLengthBytes', 'Minimum length (bytes)', site.compressionMinLengthBytes, 'Responses below 256–65536 bytes are not compressed.', 'number')}${nginxInput('site', site.key, 'compressionLevel', 'Compression level', site.compressionLevel, 'CPU/bandwidth tradeoff from 1 to 9.', 'number')}${nginxCheckbox('site', site.key, 'compressionVary', 'Emit Vary: Accept-Encoding', site.compressionVary, 'Preserve cache correctness across compressed and uncompressed variants.')}<p class="mode-warning">Compression can expose secrets when a response mixes confidential data with attacker-controlled input. Exclude sensitive responses upstream.</p>` : ''}</div></fieldset>`;
  const buffering = site.workflow === 'reverse-proxy' ? `<fieldset><legend>Proxy buffering</legend><div class="field-grid">${nginxCheckbox('site', site.key, 'proxyBuffering', 'Configure proxy buffering', site.proxyBuffering, 'Choose bounded buffering or streaming behavior for every proxy route on this site.')}${site.proxyBuffering ? `${nginxSelect('site', site.key, 'proxyBufferingProfile', 'Buffering profile', site.proxyBufferingProfile, 'Streaming disables request replay and is intended for SSE or immediate response delivery.', [{value: 'bounded', label: 'Bounded buffering'}, {value: 'streaming', label: 'Streaming / SSE'}])}${site.proxyBufferingProfile === 'bounded' ? `${nginxInput('site', site.key, 'proxyBufferSizeKb', 'Initial buffer (KiB)', site.proxyBufferSizeKb, 'First response/header buffer, 4–64 KiB.', 'number')}${nginxInput('site', site.key, 'proxyBufferCount', 'Buffer count', site.proxyBufferCount, 'Four to sixteen buffers per proxied response.', 'number')}${nginxInput('site', site.key, 'proxyBusyBuffersSizeKb', 'Busy buffer budget (KiB)', site.proxyBusyBuffersSizeKb, 'At least two buffers and below the total pool minus one buffer.', 'number')}${nginxInput('site', site.key, 'proxyMaxTempFileSizeMb', 'Temporary-file ceiling (MiB)', site.proxyMaxTempFileSizeMb, 'Zero disables spill; maximum 1024 MiB.', 'number')}` : '<p class="mode-warning">Streaming disables request and response buffering. Verify SSE heartbeats, WebSocket idle behavior, upstream backpressure and retry expectations.</p>'}` : ''}</div></fieldset>` : '';
  return `${upstream}${routes}${logging}${traffic}${security}${timeouts}${compression}${buffering}`;
}

function nginxSiteMarkup(site: NginxStudioSite, index: number): string {
  const proxyFields = site.workflow === 'reverse-proxy' && !site.useUpstream ? `${nginxInput('site', site.key, 'targetHost', 'Upstream host', site.targetHost, 'Literal hostname or IP reachable from Nginx.')}${nginxInput('site', site.key, 'targetPort', 'Upstream port', site.targetPort, 'TCP port from 1 to 65535.', 'number')}` : '';
  const staticFields = site.workflow === 'static-site' ? `${nginxInput('site', site.key, 'documentRoot', 'Document root', site.documentRoot, 'Absolute directory containing the deployed site.')}${nginxInput('site', site.key, 'indexFile', 'Index file', site.indexFile, 'Safe entry filename relative to the document root.')}${nginxCheckbox('site', site.key, 'spaFallback', 'Single Page Application fallback', site.spaFallback, 'Route missing files to the index entry.')}` : '';
  const tlsFields = `${nginxCheckbox('site', site.key, 'tls', 'Enable HTTPS', site.tls, 'Reference explicit certificate files; Forge does not inspect them.')}${site.tls ? `${nginxInput('site', site.key, 'certificatePath', 'Certificate-chain path', site.certificatePath, 'Absolute PEM path.')}${nginxInput('site', site.key, 'privateKeyPath', 'Private-key path', site.privateKeyPath, 'Distinct protected PEM path.')}${nginxCheckbox('site', site.key, 'redirectHttp', 'Redirect HTTP to HTTPS', site.redirectHttp, 'Create a separate port 80 redirect server.')}` : ''}`;
  return `<section class="site-card" data-site-key="${escapeHtml(site.key)}" aria-labelledby="${site.key}-title"><header class="site-card-header"><div><span class="item-index">Site ${index + 1}</span><h2 id="${site.key}-title">${escapeHtml(site.domain)}</h2></div><button type="button" class="button-danger" data-nginx-action="remove-site" data-site-key="${escapeHtml(site.key)}"${nginxStudio.sites.length === 1 ? ' disabled' : ''} aria-label="Remove site ${index + 1}">Remove site</button></header><div id="${site.key}-message" class="site-message" role="alert" hidden></div>
    <fieldset><legend>Site identity</legend><div class="field-grid">${nginxInput('site', site.key, 'id', 'Site ID', site.id, 'Stable lowercase identity for diagnostics and shared resources.')}${nginxSelect('site', site.key, 'workflow', 'Workflow', site.workflow, 'Choose a reverse proxy or filesystem-backed site.', [{value: 'reverse-proxy', label: 'Reverse proxy'}, {value: 'static-site', label: 'Static website'}])}${nginxInput('site', site.key, 'domain', 'Domain name', site.domain, 'Exact fully qualified server name.')}${proxyFields}${staticFields}</div></fieldset>
    <fieldset><legend>TLS & protocol</legend><div class="field-grid">${tlsFields}</div></fieldset>
    ${nginxStudio.mode === 'advanced' ? nginxAdvancedSiteMarkup(site) : ''}
  </section>`;
}

function nginxFieldsMarkup(): string {
  const advancedSummary = nginxStudio.mode === 'basic' && nginxStudio.sites.some(site => site.routes.length > 0 || site.useUpstream || site.logging || site.requestLimit || site.connectionLimit || site.securityHeaders || site.requestTimeouts || site.compression || site.proxyBuffering)
    ? '<p class="mode-warning">Advanced settings remain active in generation. Switch to Advanced to review or edit them.</p>' : '';
  return `<fieldset><legend><span>01</span>Studio mode</legend><div class="field-grid">
    ${nginxSelect('root', 'studio', 'mode', 'Configuration mode', nginxStudio.mode, 'Basic covers common site ownership and TLS. Advanced exposes collections and operational controls.', [{value: 'basic', label: 'Basic'}, {value: 'advanced', label: 'Advanced'}])}
    ${nginxSelect('root', 'studio', 'profile', 'Output profile', nginxStudio.profile, 'Complete nginx.conf or a site fragment with supporting artifacts.', [{value: 'full-config', label: 'Complete nginx.conf'}, {value: 'site-fragment', label: 'Site fragment'}])}
  </div>${advancedSummary}</fieldset><div class="collection-toolbar site-toolbar"><div><strong>Configured sites</strong><span>${nginxStudio.sites.length} of ${NGINX_STUDIO_LIMITS.sites}</span></div>${nginxStudio.mode === 'advanced' ? `<button type="button" data-nginx-action="add-site"${nginxStudio.sites.length >= NGINX_STUDIO_LIMITS.sites ? ' disabled' : ''}>+ Add site</button>` : '<span class="mode-badge">Advanced mode enables multi-site editing</span>'}</div><div class="site-list">${nginxStudio.sites.map((site, index) => nginxSiteMarkup(site, index)).join('')}</div>`;
}

function nginxCompatibilityMarkup(): string {
  return `<section class="compatibility-note" aria-labelledby="compatibility-title">
    <h2 id="compatibility-title">Assumed Nginx compatibility inputs</h2>
    <p>Forge composes for an assumed Nginx <strong>${NGINX_STUDIO_TARGET_VERSION}</strong> target with these declared modules: <code>${NGINX_STUDIO_TARGET_MODULES.join(', ')}</code>.</p>
    <p>These are generator inputs, not properties discovered from your server. Forge has not inspected installed modules, certificate files, paths, permissions, or service reachability.</p>
    <dl><div><dt>Input</dt><dd>Trusted field and capability schemas.</dd></div><div><dt>Static</dt><dd>Forge structural checks over generated artifacts.</dd></div><div><dt>Native</dt><dd><code>nginx -t</code> was not run for your generated files.</dd></div><div><dt>Target host</dt><dd>Your server and filesystem were not inspected.</dd></div></dl>
  </section>`;
}

function renderWorkspace(): void {
  const definition = definitions[selected];
  document.title = `${definition.label} Generator — Forge`;
  app.innerHTML = `${navMarkup(true)}
    <main id="main-content" class="workspace-page" tabindex="-1">
      <header class="workspace-heading"><div><p class="overline">${definition.eyebrow}</p><h1>${definition.title}</h1><p>${definition.description}</p></div><a class="back-link" href="/" data-route>All generators</a></header>
      <section class="workspace" aria-label="Generator workspace">
        <div class="panel configuration-panel"><div class="panel-label"><span>01</span> / CONFIGURATION</div>
          <form id="generator-form" novalidate>${selected === 'nginx' ? nginxFieldsMarkup() : fieldsMarkup(definition, values[selected])}${selected === 'nginx' ? nginxCompatibilityMarkup() : ''}<div id="form-message" class="form-message" role="alert" hidden></div><button class="button button-primary generate-button" type="submit">Generate configuration <span aria-hidden="true">→</span></button><p class="form-note">Inputs remain local. Forge does not connect to servers or run deployment commands.</p></form>
        </div>
        <aside class="panel preview-panel" aria-label="Generated file preview"><div class="panel-label"><span>02</span> / FILE PREVIEW</div><div id="artifact-tabs" class="artifact-tabs" aria-label="Generated artifacts"></div><div class="preview-heading"><div><span class="file-icon" aria-hidden="true">▤</span><strong id="filename">No file generated</strong></div><span id="artifact-role" class="role-badge">Waiting</span></div><pre id="preview" tabindex="0" aria-label="Configuration preview"><code id="output">Complete the form and generate a configuration.</code></pre><div id="preview-message" class="preview-message" aria-live="polite"></div><div class="preview-actions"><button id="copy" type="button" disabled>⧉ Copy</button><button id="download" type="button" disabled>↓ Download</button><button id="download-all" type="button" disabled hidden>↓ ZIP</button><button id="expand" type="button" disabled>⛶ Expand</button></div><section class="details" aria-labelledby="prerequisites-title"><h2 id="prerequisites-title">Prerequisites & cautions</h2><div id="prerequisites"><p>Generate a configuration to see target-host prerequisites.</p></div></section></aside>
      </section>
    </main>
    <section class="validation-bar" aria-label="Validation status"><strong><span aria-hidden="true">●</span> LOCAL GENERATION</strong><div id="validation-records"><span>○ Input not run</span><span>○ Static checks not run</span><span>△ Native validator unavailable</span><span>○ Target host not checked</span></div></section>
    <dialog id="expanded-preview" aria-labelledby="expanded-title"><div class="dialog-head"><div><p class="panel-label">EXPANDED FILE PREVIEW</p><h2 id="expanded-title">Generated configuration</h2></div><button id="close-expanded" type="button" aria-label="Close expanded preview">×</button></div><pre tabindex="0"><code id="expanded-output"></code></pre></dialog>`;
  bindWorkspace(); bindRoutes();
  if (staleResults[selected]) renderStaleState();
}

function valuesFingerprint(id: GeneratorId): string {
  if (id === 'nginx') return JSON.stringify(nginxStudio);
  return JSON.stringify(definitions[id].fields.map(field => [field.id, values[id][field.id]]));
}

function captureValues(): boolean {
  const form = document.getElementById('generator-form');
  if (!(form instanceof HTMLFormElement)) return false;
  const before = valuesFingerprint(selected);
  if (selected === 'nginx') {
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-nginx-control]').forEach(control => {
      const scope = control.dataset.nginxScope;
      const key = control.dataset.nginxKey ?? '';
      const field = control.dataset.nginxField;
      if (field === undefined) return;
      const value: string | boolean = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value;
      if (scope === 'root') Object.assign(nginxStudio, {[field]: value});
      else if (scope === 'site') {
        const site = nginxStudio.sites.find(item => item.key === key);
        if (site !== undefined) Object.assign(site, {[field]: value});
      } else if (scope === 'route') {
        const route = nginxStudio.sites.flatMap(site => site.routes).find(item => item.key === key);
        if (route !== undefined) Object.assign(route, {[field]: value});
      } else if (scope === 'backend') {
        const backend = nginxStudio.sites.flatMap(site => site.backends).find(item => item.key === key);
        if (backend !== undefined) Object.assign(backend, {[field]: value});
      }
    });
    return before !== valuesFingerprint(selected);
  }
  for (const field of definitions[selected].fields) {
    const control = form.elements.namedItem(field.id);
    if (control instanceof HTMLInputElement && field.type === 'checkbox') values[selected][field.id] = control.checked;
    else if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) values[selected][field.id] = control.value;
  }
  return before !== valuesFingerprint(selected);
}

function nginxSite(key: string): NginxStudioSite | undefined { return nginxStudio.sites.find(site => site.key === key); }
function rerenderNginxWorkspace(focusId?: string): void {
  if (currentResult !== null) { currentResult = null; selectedArtifactId = ''; staleResults.nginx = true; }
  renderWorkspace();
  if (focusId !== undefined) document.getElementById(focusId)?.focus();
}
function mutateNginxCollection(action: string, siteKey: string, itemKey: string): void {
  captureValues();
  const site = nginxSite(siteKey);
  let focusId: string | undefined;
  if (action === 'add-site' && nginxStudio.sites.length < NGINX_STUDIO_LIMITS.sites) {
    const created = createNginxSite(`site-${++nginxCollectionSequence}`, nginxStudio.sites.length + 1);
    nginxStudio.sites.push(created); focusId = nginxControlId(created.key, 'id');
  } else if (action === 'remove-site' && nginxStudio.sites.length > 1) {
    nginxStudio.sites = nginxStudio.sites.filter(item => item.key !== siteKey); focusId = nginxStudio.sites[0] === undefined ? undefined : nginxControlId(nginxStudio.sites[0].key, 'id');
  } else if (action === 'add-route' && site !== undefined && site.routes.length < NGINX_STUDIO_LIMITS.routesPerSite) {
    const created = createNginxRoute(`${site.key}-route-${++nginxCollectionSequence}`); site.routes.push(created); focusId = nginxControlId(created.key, 'prefix');
  } else if (action === 'remove-route' && site !== undefined) {
    site.routes = site.routes.filter(item => item.key !== itemKey); focusId = nginxControlId(site.key, 'rootWebsocket');
  } else if (action === 'add-backend' && site !== undefined && site.backends.length < NGINX_STUDIO_LIMITS.backendsPerUpstream) {
    const created = createNginxBackend(`${site.key}-backend-${++nginxCollectionSequence}`, site.backends.length + 1); site.backends.push(created); focusId = nginxControlId(created.key, 'host');
  } else if (action === 'remove-backend' && site !== undefined && site.backends.length > 2) {
    site.backends = site.backends.filter(item => item.key !== itemKey); focusId = nginxControlId(site.backends[0]?.key ?? site.key, site.backends[0] === undefined ? 'useUpstream' : 'host');
  }
  rerenderNginxWorkspace(focusId);
}
function navigate(url: string): void {
  const next = new URL(url, window.location.href); window.history.pushState({}, '', next.pathname); renderRoute();
  document.getElementById('main-content')?.focus({preventScroll: true}); window.scrollTo({top: 0});
}
function bindRoutes(): void {
  document.querySelectorAll<HTMLAnchorElement>('a[data-route]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault(); captureValues();
    const next = new URL(link.href, window.location.href);
    if (next.pathname !== window.location.pathname) navigate(link.href);
  }));
}
function bindWorkspace(): void {
  const switcher = document.getElementById('generator-switch');
  if (switcher instanceof HTMLSelectElement) switcher.addEventListener('change', () => { captureValues(); if (isGeneratorId(switcher.value)) navigate(`/generators/${switcher.value}`); });
  const form = document.getElementById('generator-form'); if (!(form instanceof HTMLFormElement)) return;
  form.addEventListener('input', event => {
    const changed = captureValues(); const target = event.target; if (target instanceof HTMLElement) clearFieldError(target.id);
    if (changed && currentResult !== null) invalidateGeneratedResult();
    const nginxVisibilityControl = target instanceof HTMLInputElement || target instanceof HTMLSelectElement ? target : undefined;
    const nginxVisibilityField = nginxVisibilityControl?.dataset.nginxField;
    const nginxVisibilityId = nginxVisibilityControl?.id;
    if (selected === 'nginx' && nginxVisibilityField !== undefined && nginxVisibilityId !== undefined && ['mode', 'workflow', 'useUpstream', 'tls', 'logging', 'accessLog', 'requestLimit', 'connectionLimit', 'securityHeaders', 'requestTimeouts', 'compression', 'proxyBuffering', 'proxyBufferingProfile'].includes(nginxVisibilityField)) rerenderNginxWorkspace(nginxVisibilityId);
  });
  form.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-nginx-action]') : null;
    if (button === null) return;
    mutateNginxCollection(button.dataset.nginxAction ?? '', button.dataset.siteKey ?? '', button.dataset.itemKey ?? '');
  });
  form.addEventListener('submit', event => { event.preventDefault(); generate(); });
  document.getElementById('copy')?.addEventListener('click', () => void copySelected());
  document.getElementById('download')?.addEventListener('click', downloadSelected);
  document.getElementById('download-all')?.addEventListener('click', downloadAll);
  document.getElementById('expand')?.addEventListener('click', openExpanded);
  document.getElementById('close-expanded')?.addEventListener('click', () => { const dialog = document.getElementById('expanded-preview'); if (dialog instanceof HTMLDialogElement) dialog.close(); });
}

function numeric(value: FieldValue): number { return typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN; }
function legacyInput(id: Exclude<GeneratorId, 'nginx'>, fieldValues: Readonly<Record<string, FieldValue>>): Record<string, FieldValue | number> {
  return id === 'compose' ? {...fieldValues, hostPort: numeric(fieldValues.hostPort ?? ''), containerPort: numeric(fieldValues.containerPort ?? '')} : {...fieldValues};
}
function generate(): void {
  captureValues(); clearErrors();
  if (selected === 'nginx') {
    const built = buildNginxStudioRequest(nginxStudio);
    nginxDiagnosticTargets = built.diagnosticTargets;
    currentResult = composeNginxSites(built.request);
  } else currentResult = outcomes[selected](legacyInput(selected, values[selected]));
  staleResults[selected] = false;
  selectedArtifactId = currentResult.ok ? currentResult.artifacts[0]?.id ?? '' : ''; renderResult();
}
function statusLabel(label: string, record: ValidationRecord): string {
  const mark = record.status === 'passed' ? '✓' : record.status === 'failed' ? '×' : record.status === 'unavailable' ? '△' : '○';
  const wording = record.status === 'unavailable' ? 'unavailable' : record.status === 'not-run' ? 'not run' : record.status;
  return `${mark} ${label} ${wording}`;
}
function selectedArtifact(): OutputArtifact | undefined {
  if (currentResult === null || !currentResult.ok) return undefined;
  return currentResult.artifacts.find(artifact => artifact.id === selectedArtifactId) ?? currentResult.artifacts[0];
}
function renderResult(): void {
  if (currentResult === null) return; renderValidation(currentResult.validation);
  if (!currentResult.ok) {
    showDiagnostics(currentResult.diagnostics); setText('filename', 'Generation blocked'); setText('artifact-role', 'Invalid input'); setText('output', 'Fix the highlighted fields, then generate again.'); setText('preview-message', 'No artifact was created.'); setActions(false, false); document.getElementById('artifact-tabs')?.replaceChildren(); renderPrerequisites([]); return;
  }
  showDiagnostics([]); renderArtifactTabs(currentResult.artifacts); renderSelectedArtifact();
  const prerequisites = 'prerequisites' in currentResult ? currentResult.prerequisites : currentResult.deploymentSteps.map((description, index) => ({code: `step-${index}`, description}));
  renderPrerequisites(prerequisites);
}
function renderArtifactTabs(artifacts: readonly OutputArtifact[]): void {
  const host = document.getElementById('artifact-tabs'); if (host === null) return; host.replaceChildren(); if (artifacts.length < 2) return;
  for (const artifact of artifacts) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = artifact.filename; button.dataset.artifactId = artifact.id; button.ariaPressed = String(artifact.id === selectedArtifactId);
    button.addEventListener('click', () => { selectedArtifactId = artifact.id; updateArtifactSelectionState(); renderSelectedArtifact(); }); host.append(button);
  }
}
function updateArtifactSelectionState(): void {
  document.querySelectorAll<HTMLButtonElement>('#artifact-tabs button').forEach(button => { button.ariaPressed = String(button.dataset.artifactId === selectedArtifactId); });
}
function renderSelectedArtifact(): void {
  const artifact = selectedArtifact(); if (artifact === undefined || currentResult === null || !currentResult.ok) return;
  setText('filename', artifact.filename); setText('artifact-role', artifact.role === 'primary' ? 'Primary' : 'Supporting'); setText('output', artifact.content); setText('expanded-output', artifact.content);
  setText('preview-message', currentResult.artifacts.length > 1 ? `${currentResult.artifacts.length} required artifacts generated. Select a file to inspect it.` : 'Configuration generated locally.'); setActions(true, currentResult.artifacts.length > 1);
}
function renderValidation(validation: ValidationSummary): void {
  const host = document.getElementById('validation-records'); if (host === null) return;
  const records: readonly [string, ValidationRecord][] = [['Input', validation.input], ['Static checks', validation.static], ['Native validator', validation.native], ['Target host', validation.targetHost ?? {status: 'not-run', diagnostics: []}]];
  host.replaceChildren(...records.map(([label, record]) => { const span = document.createElement('span'); span.className = `validation-${record.status}`; span.textContent = statusLabel(label, record); span.title = record.diagnostics.map(item => item.message).join(' ') || `${label}: ${record.status}`; return span; }));
}
function diagnosticField(diagnostic: Diagnostic): string | undefined {
  if (selected === 'nginx') return diagnosticTarget(diagnostic.path, nginxDiagnosticTargets);
  const path = diagnostic.path ?? ''; return definitions[selected].fields.map(field => field.id).find(id => path.endsWith(`.${id}`) || path === id);
}
function showDiagnostics(diagnostics: readonly Diagnostic[]): void {
  const general: string[] = [];
  for (const diagnostic of diagnostics.filter(item => item.severity === 'error')) {
    const field = diagnosticField(diagnostic);
    const site = selected === 'nginx' && diagnostic.siteId !== undefined ? nginxStudio.sites.find(item => item.id === diagnostic.siteId) : undefined;
    if (field === undefined && site !== undefined) {
      const message = document.getElementById(`${site.key}-message`);
      if (message instanceof HTMLElement) { message.hidden = false; message.textContent = diagnostic.message; }
    }
    else if (field === undefined) general.push(diagnostic.message);
    else { setText(`${field}-error`, diagnostic.message); document.getElementById(field)?.setAttribute('aria-invalid', 'true'); document.querySelector(`[data-field-wrap="${field}"]`)?.classList.add('has-error'); }
  }
  const message = document.getElementById('form-message'); if (message instanceof HTMLElement) { message.hidden = general.length === 0; message.textContent = general.join(' '); }
  document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}
function clearFieldError(id: string): void { document.getElementById(id)?.removeAttribute('aria-invalid'); document.querySelector(`[data-field-wrap="${id}"]`)?.classList.remove('has-error'); setText(`${id}-error`, ''); }
function clearErrors(): void {
  if (selected === 'nginx') {
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-nginx-control]').forEach(control => clearFieldError(control.id));
    nginxStudio.sites.forEach(site => { const message = document.getElementById(`${site.key}-message`); if (message instanceof HTMLElement) { message.hidden = true; message.textContent = ''; } });
  } else definitions[selected].fields.forEach(field => clearFieldError(field.id));
  const message = document.getElementById('form-message'); if (message instanceof HTMLElement) { message.hidden = true; message.textContent = ''; }
}
function renderPrerequisites(items: readonly {readonly description: string; readonly path?: string}[]): void {
  const host = document.getElementById('prerequisites'); if (host === null) return; host.replaceChildren();
  if (items.length === 0) { const paragraph = document.createElement('p'); paragraph.textContent = 'No artifacts were produced, so prerequisites are unavailable.'; host.append(paragraph); return; }
  const list = document.createElement('ul'); for (const item of items) { const entry = document.createElement('li'); entry.textContent = item.path === undefined ? item.description : `${item.description} (${item.path})`; list.append(entry); } host.append(list);
}
function renderIdleValidation(): void {
  const host = document.getElementById('validation-records'); if (host === null) return;
  const labels = ['○ Input not run', '○ Static checks not run', '△ Native validator unavailable', '○ Target host not checked'];
  host.replaceChildren(...labels.map(label => { const span = document.createElement('span'); span.textContent = label; return span; }));
}
function invalidateGeneratedResult(): void {
  currentResult = null; selectedArtifactId = ''; staleResults[selected] = true; renderStaleState();
}
function renderStaleState(): void {
  document.getElementById('artifact-tabs')?.replaceChildren();
  setText('filename', 'Regeneration required'); setText('artifact-role', 'Outdated');
  setText('output', 'Configuration changed — regenerate to update the output.'); setText('expanded-output', '');
  setText('preview-message', 'Configuration changed — regenerate to update the output.');
  setActions(false, false); renderIdleValidation();
  const host = document.getElementById('prerequisites');
  if (host !== null) { const paragraph = document.createElement('p'); paragraph.textContent = 'Current inputs have not been generated or checked.'; host.replaceChildren(paragraph); }
}
function setActions(enabled: boolean, multiple: boolean): void {
  for (const id of ['copy', 'download', 'expand']) { const button = document.getElementById(id); if (button instanceof HTMLButtonElement) button.disabled = !enabled; }
  const all = document.getElementById('download-all'); if (all instanceof HTMLButtonElement) { all.disabled = !enabled || !multiple; all.hidden = !multiple; }
}
async function copySelected(): Promise<void> {
  const artifact = selectedArtifact(); if (artifact === undefined) return;
  try { await navigator.clipboard.writeText(artifact.content); setText('preview-message', `${artifact.filename} copied to the clipboard.`); } catch { setText('preview-message', 'Clipboard access is unavailable. Select the preview text and copy it manually.'); }
}
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
function downloadSelected(): void { const artifact = selectedArtifact(); if (artifact === undefined) return; saveBlob(new Blob([artifact.content], {type: `${artifact.mediaType};charset=utf-8`}), artifact.filename); setText('preview-message', `${artifact.filename} download prepared.`); }
function downloadAll(): void { if (currentResult === null || !currentResult.ok || currentResult.artifacts.length < 2) return; saveBlob(createZipBlob(currentResult.artifacts), 'forge-nginx-artifacts.zip'); setText('preview-message', `ZIP prepared with ${currentResult.artifacts.length} required artifacts.`); }
function openExpanded(): void { const artifact = selectedArtifact(); const dialog = document.getElementById('expanded-preview'); if (artifact === undefined || !(dialog instanceof HTMLDialogElement)) return; setText('expanded-title', artifact.filename); setText('expanded-output', artifact.content); dialog.showModal(); document.getElementById('close-expanded')?.focus(); }
function setText(id: string, value: string): void { const element = document.getElementById(id); if (element !== null) element.textContent = value; }
function renderRoute(): void { const routeGenerator = generatorFromPath(window.location.pathname); if (routeGenerator !== null) { selected = routeGenerator; currentResult = null; selectedArtifactId = ''; renderWorkspace(); } else renderLanding(); }

window.addEventListener('popstate', renderRoute);
renderRoute();
