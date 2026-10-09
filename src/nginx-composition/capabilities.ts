import type {Diagnostic} from '../core/types.js';
import {validateArgument} from '../nginx-syntax/arguments.js';
import {block, directive, mapEntry, nginxArgument as arg} from '../nginx-syntax/types.js';
import type {NginxArgumentKind, NginxSourceProvenance} from '../nginx-syntax/types.js';
import type {
  CapabilityValidation,
  NginxCapabilityDefinition,
  NginxCapabilityId,
  ReverseProxyInput,
  RouteInput,
  RoutingInput,
  StaticSiteInput,
  TlsInput,
  UpstreamBackendInput,
  UpstreamLoadBalancingInput,
  WebSocketInput,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

const inputError = (code: string, message: string, path: string): Diagnostic => ({code, message, path, severity: 'error', stage: 'input'});

function failure<T>(diagnostic: Diagnostic): CapabilityValidation<T> {
  return {ok: false, diagnostics: [diagnostic]};
}

function success<T>(value: T): CapabilityValidation<T> {
  return {ok: true, value, diagnostics: []};
}

function record(value: unknown, path: string, allowed: readonly string[]): CapabilityValidation<UnknownRecord> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return failure(inputError('composition.input.type', 'Capability input must be an object.', path));
  const candidate = value as UnknownRecord;
  const unknown = Object.keys(candidate).filter(key => !allowed.includes(key)).sort()[0];
  if (unknown !== undefined) return failure(inputError('composition.input.unknown', `Unsupported capability input field: ${unknown}.`, `${path}.${unknown}`));
  return success(candidate);
}

function stringValue(value: unknown, label: string, path: string): CapabilityValidation<string> {
  if (typeof value !== 'string') return failure(inputError('composition.input.string', `${label} must be a string.`, path));
  const normalized = value.trim();
  if (normalized.length === 0) return failure(inputError('composition.input.string', `${label} must not be empty.`, path));
  return success(normalized);
}

function integerValue(value: unknown, label: string, path: string): CapabilityValidation<number> {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    return failure(inputError('composition.input.port', `${label} must be an integer between 1 and 65535.`, path));
  }
  return success(value);
}

function boundedInteger(value: unknown, label: string, path: string, minimum: number, maximum: number, defaultValue?: number): CapabilityValidation<number> {
  if (value === undefined && defaultValue !== undefined) return success(defaultValue);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return failure(inputError('composition.input.integer', `${label} must be an integer between ${minimum} and ${maximum}.`, path));
  }
  return success(value);
}

function booleanValue(value: unknown, label: string, path: string, defaultValue: boolean): CapabilityValidation<boolean> {
  if (value === undefined) return success(defaultValue);
  return typeof value === 'boolean'
    ? success(value)
    : failure(inputError('composition.input.boolean', `${label} must be a boolean.`, path));
}

function typedString(value: unknown, kind: NginxArgumentKind, label: string, path: string): CapabilityValidation<string> {
  const parsed = stringValue(value, label, path);
  if (!parsed.ok) return parsed;
  const message = validateArgument({kind, value: parsed.value}, {kinds: [kind]});
  return message === undefined ? parsed : failure(inputError('composition.input.grammar', `${label}: ${message}`, path));
}

function target(value: unknown, path: string): CapabilityValidation<{readonly host: string; readonly port: number}> {
  const targetRecord = record(value, path, ['targetHost', 'targetPort']);
  if (!targetRecord.ok) return targetRecord;
  const host = stringValue(targetRecord.value.targetHost, 'Target host', `${path}.targetHost`);
  if (!host.ok) return host;
  const port = integerValue(targetRecord.value.targetPort, 'Target port', `${path}.targetPort`);
  if (!port.ok) return port;
  const message = validateArgument(arg.upstreamAddress(`${host.value}:${port.value}`), {kinds: ['upstream-address']});
  if (message !== undefined) return failure(inputError('composition.input.target', `Target host and port are invalid: ${message}`, `${path}.targetHost`));
  return success({host: host.value.toLowerCase(), port: port.value});
}

function validateReverseProxy(input: unknown, path: string): CapabilityValidation<ReverseProxyInput> {
  const object = record(input, path, ['domain', 'targetHost', 'targetPort', 'upstreamId']);
  if (!object.ok) return object;
  const domain = typedString(object.value.domain, 'domain', 'Domain', `${path}.domain`);
  if (!domain.ok) return domain;
  const hasDirectField = object.value.targetHost !== undefined || object.value.targetPort !== undefined;
  const hasUpstream = object.value.upstreamId !== undefined;
  if (hasDirectField === hasUpstream) {
    return failure(inputError('composition.proxy.target-choice', 'Choose exactly one proxy target: targetHost with targetPort, or upstreamId.', path));
  }
  if (hasUpstream) {
    const upstreamId = typedString(object.value.upstreamId, 'identifier', 'Upstream ID', `${path}.upstreamId`);
    if (!upstreamId.ok || !/^[a-z](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(upstreamId.value)) {
      return failure(inputError('composition.upstream.id', 'Upstream ID must be 1-31 lowercase letters, digits, or internal hyphens and begin with a letter.', `${path}.upstreamId`));
    }
    return success({domain: domain.value.toLowerCase(), upstreamId: upstreamId.value});
  }
  const parsedTarget = target({targetHost: object.value.targetHost, targetPort: object.value.targetPort}, path);
  if (!parsedTarget.ok) return parsedTarget;
  return success({domain: domain.value.toLowerCase(), targetHost: parsedTarget.value.host, targetPort: parsedTarget.value.port});
}

function upstreamNginxName(upstreamId: string): string {
  return `forge_${upstreamId.replaceAll('-', '_')}`;
}

function validateUpstreamBackend(value: unknown, path: string): CapabilityValidation<UpstreamBackendInput> {
  const object = record(value, path, ['host', 'port', 'weight', 'maxFails', 'failTimeoutSeconds', 'backup', 'down']);
  if (!object.ok) return object;
  const parsedTarget = target({targetHost: object.value.host, targetPort: object.value.port}, path);
  if (!parsedTarget.ok) return parsedTarget;
  const weight = boundedInteger(object.value.weight, 'Backend weight', `${path}.weight`, 1, 100, 1);
  if (!weight.ok) return weight;
  const maxFails = boundedInteger(object.value.maxFails, 'Backend maxFails', `${path}.maxFails`, 0, 10, 1);
  if (!maxFails.ok) return maxFails;
  const failTimeoutSeconds = boundedInteger(object.value.failTimeoutSeconds, 'Backend failTimeoutSeconds', `${path}.failTimeoutSeconds`, 1, 300, 10);
  if (!failTimeoutSeconds.ok) return failTimeoutSeconds;
  const backup = booleanValue(object.value.backup, 'Backend backup', `${path}.backup`, false);
  if (!backup.ok) return backup;
  const down = booleanValue(object.value.down, 'Backend down', `${path}.down`, false);
  if (!down.ok) return down;
  if (backup.value && down.value) return failure(inputError('composition.upstream.backend-state', 'A backend cannot be both backup and down.', path));
  return success({host: parsedTarget.value.host, port: parsedTarget.value.port, weight: weight.value, maxFails: maxFails.value, failTimeoutSeconds: failTimeoutSeconds.value, backup: backup.value, down: down.value});
}

function validateUpstreamLoadBalancing(input: unknown, path: string): CapabilityValidation<UpstreamLoadBalancingInput> {
  const object = record(input, path, ['upstreamId', 'strategy', 'backends']);
  if (!object.ok) return object;
  const upstreamId = stringValue(object.value.upstreamId, 'Upstream ID', `${path}.upstreamId`);
  if (!upstreamId.ok || !/^[a-z](?:[a-z0-9-]{0,29}[a-z0-9])?$/.test(upstreamId.value)) {
    return failure(inputError('composition.upstream.id', 'Upstream ID must be 1-31 lowercase letters, digits, or internal hyphens and begin with a letter.', `${path}.upstreamId`));
  }
  const strategy = object.value.strategy ?? 'round-robin';
  if (strategy !== 'round-robin' && strategy !== 'least-connections') {
    return failure(inputError('composition.upstream.strategy', 'Strategy must be round-robin or least-connections.', `${path}.strategy`));
  }
  if (!Array.isArray(object.value.backends) || object.value.backends.length < 2 || object.value.backends.length > 16) {
    return failure(inputError('composition.upstream.backends', 'Upstream load balancing requires between 2 and 16 backends.', `${path}.backends`));
  }
  const backends: UpstreamBackendInput[] = [];
  const addresses = new Set<string>();
  const nginxName = upstreamNginxName(upstreamId.value);
  for (let index = 0; index < object.value.backends.length; index += 1) {
    const backend = validateUpstreamBackend(object.value.backends[index], `${path}.backends[${index}]`);
    if (!backend.ok) return backend;
    const address = `${backend.value.host}:${backend.value.port}`;
    if (addresses.has(address)) return failure(inputError('composition.upstream.backend-duplicate', `Backend ${address} is duplicated.`, `${path}.backends[${index}]`));
    if (backend.value.host === nginxName || backend.value.host === upstreamId.value) {
      return failure(inputError('composition.upstream.name-collision', `Backend host ${backend.value.host} collides with the upstream identity.`, `${path}.backends[${index}].host`));
    }
    addresses.add(address);
    backends.push(backend.value);
  }
  if (backends.filter(backend => !backend.down).length < 2) {
    return failure(inputError('composition.upstream.available-backends', 'At least two backends must not be marked down; Nginx ignores passive failure controls for an effectively single-server group.', `${path}.backends`));
  }
  if (!backends.some(backend => !backend.down && !backend.backup)) {
    return failure(inputError('composition.upstream.primary-backend', 'At least one backend must be an enabled primary server.', `${path}.backends`));
  }
  backends.sort((left, right) => `${left.host}:${left.port}`.localeCompare(`${right.host}:${right.port}`, 'en'));
  return success({upstreamId: upstreamId.value, strategy, backends});
}

function validateRoute(value: unknown, path: string): CapabilityValidation<RouteInput> {
  const object = record(value, path, ['prefix', 'targetHost', 'targetPort', 'forwarding']);
  if (!object.ok) return object;
  const prefix = typedString(object.value.prefix, 'location-prefix', 'Route prefix', `${path}.prefix`);
  if (!prefix.ok) return prefix;
  const parsedTarget = target({targetHost: object.value.targetHost, targetPort: object.value.targetPort}, path);
  if (!parsedTarget.ok) return parsedTarget;
  if (object.value.forwarding !== 'preserve-prefix' && object.value.forwarding !== 'strip-prefix') {
    return failure(inputError('composition.input.enum', 'Route forwarding must be preserve-prefix or strip-prefix.', `${path}.forwarding`));
  }
  if (object.value.forwarding === 'strip-prefix' && !prefix.value.endsWith('/')) {
    return failure(inputError('composition.route.strip-prefix', 'A strip-prefix route must end with / so Nginx URI replacement is unambiguous.', `${path}.prefix`));
  }
  return success({
    prefix: prefix.value,
    targetHost: parsedTarget.value.host,
    targetPort: parsedTarget.value.port,
    forwarding: object.value.forwarding,
  });
}

function validateRouting(input: unknown, path: string): CapabilityValidation<RoutingInput> {
  const object = record(input, path, ['routes']);
  if (!object.ok) return object;
  if (!Array.isArray(object.value.routes) || object.value.routes.length === 0 || object.value.routes.length > 32) {
    return failure(inputError('composition.routes.count', 'Routing requires between 1 and 32 routes.', `${path}.routes`));
  }
  const routes: RouteInput[] = [];
  for (let index = 0; index < object.value.routes.length; index += 1) {
    const route = validateRoute(object.value.routes[index], `${path}.routes[${index}]`);
    if (!route.ok) return route;
    routes.push(route.value);
  }
  return success({routes});
}

function validateTls(input: unknown, path: string): CapabilityValidation<TlsInput> {
  const object = record(input, path, ['certificatePath', 'privateKeyPath', 'redirectHttp']);
  if (!object.ok) return object;
  const certificatePath = typedString(object.value.certificatePath, 'file-path', 'Certificate path', `${path}.certificatePath`);
  if (!certificatePath.ok) return certificatePath;
  const privateKeyPath = typedString(object.value.privateKeyPath, 'file-path', 'Private-key path', `${path}.privateKeyPath`);
  if (!privateKeyPath.ok) return privateKeyPath;
  if (certificatePath.value === privateKeyPath.value) return failure(inputError('composition.tls.paths', 'Certificate and private-key paths must be different files.', path));
  const redirectHttp = booleanValue(object.value.redirectHttp, 'HTTP redirect', `${path}.redirectHttp`, false);
  if (!redirectHttp.ok) return redirectHttp;
  return success({certificatePath: certificatePath.value, privateKeyPath: privateKeyPath.value, redirectHttp: redirectHttp.value});
}

function validateWebSocket(input: unknown, path: string): CapabilityValidation<WebSocketInput> {
  const object = record(input, path, ['routes']);
  if (!object.ok) return object;
  if (!Array.isArray(object.value.routes) || object.value.routes.length === 0 || object.value.routes.length > 32) {
    return failure(inputError('composition.websocket.routes', 'WebSocket support requires between 1 and 32 explicit route prefixes.', `${path}.routes`));
  }
  const routes: string[] = [];
  for (let index = 0; index < object.value.routes.length; index += 1) {
    const route = typedString(object.value.routes[index], 'location-prefix', 'WebSocket route', `${path}.routes[${index}]`);
    if (!route.ok) return route;
    routes.push(route.value);
  }
  return success({routes});
}

function validateStaticSite(input: unknown, path: string): CapabilityValidation<StaticSiteInput> {
  const object = record(input, path, ['domain', 'documentRoot', 'indexFile', 'spaFallback']);
  if (!object.ok) return object;
  const domain = typedString(object.value.domain, 'domain', 'Domain', `${path}.domain`);
  if (!domain.ok) return domain;
  const documentRoot = typedString(object.value.documentRoot, 'directory-path', 'Document root', `${path}.documentRoot`);
  if (!documentRoot.ok) return documentRoot;
  const indexFile = typedString(object.value.indexFile, 'index-file', 'Index file', `${path}.indexFile`);
  if (!indexFile.ok) return indexFile;
  const spaFallback = booleanValue(object.value.spaFallback, 'SPA fallback', `${path}.spaFallback`, false);
  if (!spaFallback.ok) return spaFallback;
  return success({domain: domain.value.toLowerCase(), documentRoot: documentRoot.value, indexFile: indexFile.value, spaFallback: spaFallback.value});
}

function source(id: NginxCapabilityId, version: string): NginxSourceProvenance {
  return {kind: 'capability', id, version};
}

const reverseProxy: NginxCapabilityDefinition<ReverseProxyInput> = {
  id: 'reverse-proxy',
  version: '2.1.0',
  inputSchema: {version: '1.1', additionalProperties: false, fields: [
    {name: 'domain', type: 'string', required: true, description: 'Fully qualified server name.'},
    {name: 'targetHost', type: 'string', required: false, description: 'Literal direct-target hostname or IP address; paired with targetPort.'},
    {name: 'targetPort', type: 'integer', required: false, description: 'Direct-target TCP port; paired with targetHost.'},
    {name: 'upstreamId', type: 'string', required: false, description: 'Reference to an explicitly selected upstream-load-balancing capability.'},
  ]},
  dependencies: [],
  incompatibleWith: [],
  requiresSiteOwner: false,
  astSurface: {contexts: ['server', 'location'], directives: ['listen', 'server_name', 'proxy_pass', 'proxy_http_version', 'proxy_set_header'], blocks: ['server', 'location']},
  requirements: () => ({minimumNginxVersion: '1.18.0', modules: ['http_proxy']}),
  validate: validateReverseProxy,
  contribute(input) {
    const provenance = source(this.id, this.version);
    const plannedTarget = 'upstreamId' in input
      ? {kind: 'upstream' as const, id: input.upstreamId, nginxName: upstreamNginxName(input.upstreamId)}
      : {kind: 'direct' as const, host: input.targetHost, port: input.targetPort};
    return {
      domain: input.domain,
      routes: [{prefix: '/', target: plannedTarget, forwarding: 'preserve-prefix', source: provenance}],
      explanations: [{code: 'composition.proxy.route', capabilityId: this.id, context: 'location', semanticIdentity: 'location:prefix:/' , message: 'A root reverse-proxy route was added with prefix-preserving URI forwarding.'}],
      prerequisites: [{code: 'composition.proxy.service', capabilityId: this.id, kind: 'service', description: 'The configured upstream service must be reachable from Nginx.'}],
    };
  },
};

const upstreamLoadBalancing: NginxCapabilityDefinition<UpstreamLoadBalancingInput> = {
  id: 'upstream-load-balancing',
  version: '4.1.0',
  inputSchema: {version: '1.0', additionalProperties: false, fields: [
    {name: 'upstreamId', type: 'string', required: true, description: 'Stable logical identity rendered in the Forge-owned upstream namespace.'},
    {name: 'strategy', type: 'enum', required: false, values: ['round-robin', 'least-connections'], description: 'Weighted round robin by default, or weighted least connections.'},
    {name: 'backends', type: 'array', required: true, maximumItems: 16, description: 'Two to sixteen typed backend server definitions.'},
  ]},
  dependencies: ['reverse-proxy'],
  incompatibleWith: ['static-site'],
  requiresSiteOwner: false,
  astSurface: {contexts: ['http', 'upstream'], directives: ['least_conn', 'server'], blocks: ['upstream']},
  requirements: () => ({minimumNginxVersion: '1.18.0', modules: []}),
  validate: validateUpstreamLoadBalancing,
  contribute(input) {
    const provenance = source(this.id, this.version);
    const children = [
      ...(input.strategy === 'least-connections' ? [directive('least_conn', [], provenance)] : []),
      ...input.backends.map(backend => {
        const parameters = [
          ...(backend.weight === 1 ? [] : [arg.upstreamParameter(`weight=${backend.weight}`)]),
          arg.upstreamParameter(`max_fails=${backend.maxFails}`),
          arg.upstreamParameter(`fail_timeout=${backend.failTimeoutSeconds}s`),
          ...(backend.backup ? [arg.upstreamParameter('backup')] : []),
          ...(backend.down ? [arg.upstreamParameter('down')] : []),
        ];
        return directive('upstream_server', [arg.upstreamAddress(`${backend.host}:${backend.port}`), ...parameters], provenance);
      }),
    ];
    const nginxName = upstreamNginxName(input.upstreamId);
    return {
      sharedHttpNodes: [block('upstream', [arg.identifier(nginxName)], children, provenance)],
      prerequisites: [
        {code: 'composition.upstream.reachability', capabilityId: this.id, kind: 'service', description: 'Every enabled backend must be reachable from the Nginx host; Forge does not probe backend health.'},
        {code: 'composition.upstream.failure-policy', capabilityId: this.id, kind: 'operator-action', description: 'Validate passive failure thresholds and load distribution under representative production traffic before rollout.'},
      ],
      explanations: [
        {code: `composition.upstream.strategy.${input.strategy}`, capabilityId: this.id, context: 'upstream', semanticIdentity: `upstream:${nginxName}`, message: input.strategy === 'least-connections' ? 'Requests use weighted least-connections selection; ties use weighted round robin.' : 'Requests use Nginx weighted round-robin selection.'},
        {code: 'composition.upstream.passive-failures', capabilityId: this.id, context: 'upstream', semanticIdentity: `upstream:${nginxName}`, message: 'max_fails and fail_timeout provide passive failure handling based on proxy request failures; no active health checks are configured or implied.'},
      ],
    };
  },
};

const routing: NginxCapabilityDefinition<RoutingInput> = {
  id: 'routing',
  version: '2.0.0',
  inputSchema: {version: '1.0', additionalProperties: false, fields: [
    {name: 'routes', type: 'array', required: true, maximumItems: 32, description: 'Literal-prefix routes with explicit targets and URI-forwarding behavior.'},
  ]},
  dependencies: ['reverse-proxy'],
  incompatibleWith: [],
  requiresSiteOwner: false,
  astSurface: {contexts: ['server', 'location'], directives: ['proxy_pass', 'proxy_http_version', 'proxy_set_header'], blocks: ['location']},
  requirements: () => ({minimumNginxVersion: '1.18.0', modules: ['http_proxy']}),
  validate: validateRouting,
  contribute(input) {
    const provenance = source(this.id, this.version);
    return {
      routes: input.routes.map(route => ({
        prefix: route.prefix,
        target: {kind: 'direct' as const, host: route.targetHost, port: route.targetPort},
        forwarding: route.forwarding,
        source: provenance,
      })),
      explanations: input.routes.map(route => ({
        code: `composition.route.${route.forwarding}`,
        capabilityId: this.id,
        context: 'location' as const,
        semanticIdentity: `location:prefix:${route.prefix}`,
        message: route.forwarding === 'preserve-prefix'
          ? 'A literal-prefix route was added without a proxy URI so Nginx preserves the original request URI.'
          : 'A literal-prefix route was added with a trailing proxy URI so Nginx replaces the matched prefix.',
      })),
    };
  },
};

const staticSite: NginxCapabilityDefinition<StaticSiteInput> = {
  id: 'static-site',
  version: '4.0.0',
  inputSchema: {version: '1.0', additionalProperties: false, fields: [
    {name: 'domain', type: 'string', required: true, description: 'Fully qualified server name.'},
    {name: 'documentRoot', type: 'string', required: true, description: 'Absolute directory containing the deployed static assets.'},
    {name: 'indexFile', type: 'string', required: true, description: 'Safe entry filename relative to the document root.'},
    {name: 'spaFallback', type: 'boolean', required: false, description: 'Internally redirect unresolved routes to the entry file.'},
  ]},
  dependencies: [],
  incompatibleWith: ['reverse-proxy', 'routing', 'websocket'],
  requiresSiteOwner: false,
  astSurface: {contexts: ['http', 'server', 'location'], directives: ['default_type', 'include', 'index', 'listen', 'root', 'server_name', 'try_files'], blocks: ['server', 'location']},
  requirements: () => ({minimumNginxVersion: '1.18.0', modules: []}),
  validate: validateStaticSite,
  contribute(input) {
    const provenance = source(this.id, this.version);
    const fallback = input.spaFallback ? `/${input.indexFile}` : '=404';
    return {
      domain: input.domain,
      staticSite: {
        source: provenance,
        spaFallback: input.spaFallback,
        serverDirectives: [
          directive('root', [arg.directoryPath(input.documentRoot)], provenance),
          directive('index', [arg.indexFile(input.indexFile)], provenance),
        ],
        rootLocation: block('location', [arg.locationPrefix('/')], [
          directive('try_files', [arg.tryFileCandidate('$uri'), arg.tryFileCandidate('$uri/'), arg.tryFileFallback(fallback)], provenance),
        ], provenance),
      },
      sharedHttpNodes: [
        directive('include', [arg.filePath('/etc/nginx/mime.types')], provenance),
        directive('default_type', [arg.literal('application/octet-stream')], provenance),
      ],
      prerequisites: [
        {code: 'composition.static.document-root', capabilityId: this.id, kind: 'directory', description: 'The document root must exist on the target host.', path: input.documentRoot},
        {code: 'composition.static.permissions', capabilityId: this.id, kind: 'operator-action', description: 'Grant the Nginx worker read access to hosted files and traverse access to every parent directory.'},
        {code: 'composition.static.index-file', capabilityId: this.id, kind: 'file', description: 'The configured index file must be deployed and readable by Nginx.', path: `${input.documentRoot}/${input.indexFile}`},
        {code: 'composition.static.assets', capabilityId: this.id, kind: 'operator-action', description: 'Deploy the intended static asset set before enabling traffic.'},
        {code: 'composition.static.mime-types', capabilityId: this.id, kind: 'file', description: 'The trusted MIME type mapping must exist and be readable by Nginx.', path: '/etc/nginx/mime.types'},
      ],
      explanations: [
        {code: 'composition.static.root', capabilityId: this.id, context: 'server', semanticIdentity: 'location:prefix:/', message: 'A filesystem-backed root location serves assets from the validated document root.'},
        {code: input.spaFallback ? 'composition.static.spa-fallback' : 'composition.static.not-found', capabilityId: this.id, context: 'location', semanticIdentity: 'try-files:root', message: input.spaFallback ? 'Unresolved URIs internally redirect to the configured SPA entry file after file and directory checks.' : 'Unresolved URIs return 404 after file and directory checks.'},
        {code: 'composition.static.mime-types', capabilityId: this.id, context: 'http', semanticIdentity: 'directive:include', message: 'A trusted MIME type mapping is included once at HTTP scope for static asset responses.'},
      ],
    };
  },
};

const tls: NginxCapabilityDefinition<TlsInput> = {
  id: 'tls',
  version: '2.0.0',
  inputSchema: {version: '1.0', additionalProperties: false, fields: [
    {name: 'certificatePath', type: 'string', required: true, description: 'Existing PEM certificate-chain file path.'},
    {name: 'privateKeyPath', type: 'string', required: true, description: 'Existing PEM private-key file path.'},
    {name: 'redirectHttp', type: 'boolean', required: false, description: 'Create an HTTP server that redirects to the configured HTTPS server.'},
  ]},
  dependencies: [],
  incompatibleWith: [],
  requiresSiteOwner: true,
  astSurface: {contexts: ['server'], directives: ['listen', 'return', 'ssl_certificate', 'ssl_certificate_key', 'ssl_protocols'], blocks: ['server']},
  requirements: input => ({minimumNginxVersion: '1.18.0', modules: input.redirectHttp ? ['http_ssl', 'http_rewrite'] : ['http_ssl']}),
  validate: validateTls,
  contribute(input) {
    const provenance = source(this.id, this.version);
    return {
      tls: {
        source: provenance,
        redirectHttp: input.redirectHttp,
        directives: [
          directive('ssl_certificate', [arg.filePath(input.certificatePath)], provenance),
          directive('ssl_certificate_key', [arg.filePath(input.privateKeyPath)], provenance),
          directive('ssl_protocols', [arg.keyword('TLSv1.2'), arg.keyword('TLSv1.3')], provenance),
        ],
      },
      prerequisites: [
        {code: 'composition.tls.certificate', capabilityId: this.id, kind: 'file', description: 'The certificate-chain file must exist and be readable by Nginx.', path: input.certificatePath},
        {code: 'composition.tls.private-key', capabilityId: this.id, kind: 'file', description: 'The private-key file must exist, be protected, and be readable by Nginx.', path: input.privateKeyPath},
      ],
      explanations: [
        {code: 'composition.tls.listener', capabilityId: this.id, context: 'server', semanticIdentity: 'listen:443:ssl', message: 'An HTTPS listener and explicit certificate references were added.'},
        ...(input.redirectHttp ? [{code: 'composition.tls.redirect', capabilityId: this.id, context: 'server' as const, semanticIdentity: 'listen:80:redirect', message: 'A separate HTTP server redirects requests to the explicitly configured HTTPS listener.'}] : []),
      ],
    };
  },
};

const websocket: NginxCapabilityDefinition<WebSocketInput> = {
  id: 'websocket',
  version: '2.0.0',
  inputSchema: {version: '1.0', additionalProperties: false, fields: [
    {name: 'routes', type: 'array', required: true, maximumItems: 32, description: 'Existing proxy route prefixes that require protocol upgrade handling.'},
  ]},
  dependencies: ['reverse-proxy'],
  incompatibleWith: [],
  requiresSiteOwner: false,
  astSurface: {contexts: ['http', 'location'], directives: ['proxy_http_version', 'proxy_set_header'], blocks: ['map']},
  requirements: () => ({minimumNginxVersion: '1.3.13', modules: ['http_map', 'http_proxy']}),
  validate: validateWebSocket,
  contribute(input) {
    const provenance = source(this.id, this.version);
    return {
      websocketRoutes: input.routes,
      sharedHttpNodes: [block('map', [arg.variable('$http_upgrade'), arg.variable('$connection_upgrade')], [
        mapEntry(arg.keyword('default'), arg.literal('upgrade'), provenance),
        mapEntry(arg.quoted(''), arg.literal('close'), provenance),
      ], provenance)],
      explanations: [
        {code: 'composition.websocket.map', capabilityId: this.id, context: 'http', semanticIdentity: 'map:$connection_upgrade', message: 'One shared upgrade map was added at HTTP scope because WebSocket hop-by-hop headers must be supplied explicitly.'},
        ...input.routes.map(route => ({code: 'composition.websocket.route', capabilityId: this.id, context: 'location' as const, semanticIdentity: `location:prefix:${route}`, message: 'WebSocket Upgrade and Connection headers were added to a compatible proxy route.'})),
      ],
    };
  },
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const definitions = deepFreeze({reverseProxy, routing, staticSite, tls, upstreamLoadBalancing, websocket} as const);

export function getCapabilityDefinition(id: string): NginxCapabilityDefinition | undefined {
  return Object.values(definitions).find(definition => definition.id === id);
}

export function listCapabilityDefinitions(): readonly NginxCapabilityDefinition[] {
  return Object.values(definitions);
}
