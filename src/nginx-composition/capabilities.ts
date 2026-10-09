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
  TlsInput,
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
  const object = record(input, path, ['domain', 'targetHost', 'targetPort']);
  if (!object.ok) return object;
  const domain = typedString(object.value.domain, 'domain', 'Domain', `${path}.domain`);
  if (!domain.ok) return domain;
  const parsedTarget = target({targetHost: object.value.targetHost, targetPort: object.value.targetPort}, path);
  if (!parsedTarget.ok) return parsedTarget;
  return success({domain: domain.value.toLowerCase(), targetHost: parsedTarget.value.host, targetPort: parsedTarget.value.port});
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

function source(id: NginxCapabilityId, version: string): NginxSourceProvenance {
  return {kind: 'capability', id, version};
}

const reverseProxy: NginxCapabilityDefinition<ReverseProxyInput> = {
  id: 'reverse-proxy',
  version: '2.0.0',
  inputSchema: {version: '1.0', additionalProperties: false, fields: [
    {name: 'domain', type: 'string', required: true, description: 'Fully qualified server name.'},
    {name: 'targetHost', type: 'string', required: true, description: 'Literal upstream hostname or IP address.'},
    {name: 'targetPort', type: 'integer', required: true, description: 'Upstream TCP port.'},
  ]},
  dependencies: [],
  incompatibleWith: [],
  astSurface: {contexts: ['server', 'location'], directives: ['listen', 'server_name', 'proxy_pass', 'proxy_http_version', 'proxy_set_header'], blocks: ['server', 'location']},
  requirements: () => ({minimumNginxVersion: '1.18.0', modules: ['http_proxy']}),
  validate: validateReverseProxy,
  contribute(input) {
    const provenance = source(this.id, this.version);
    return {
      domain: input.domain,
      routes: [{prefix: '/', targetHost: input.targetHost, targetPort: input.targetPort, forwarding: 'preserve-prefix', source: provenance}],
      explanations: [{code: 'composition.proxy.route', capabilityId: this.id, context: 'location', semanticIdentity: 'location:prefix:/' , message: 'A root reverse-proxy route was added with prefix-preserving URI forwarding.'}],
      prerequisites: [{code: 'composition.proxy.service', capabilityId: this.id, kind: 'service', description: 'The configured upstream service must be reachable from Nginx.'}],
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
  astSurface: {contexts: ['server', 'location'], directives: ['proxy_pass', 'proxy_http_version', 'proxy_set_header'], blocks: ['location']},
  requirements: () => ({minimumNginxVersion: '1.18.0', modules: ['http_proxy']}),
  validate: validateRouting,
  contribute(input) {
    const provenance = source(this.id, this.version);
    return {
      routes: input.routes.map(route => ({...route, source: provenance})),
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

const tls: NginxCapabilityDefinition<TlsInput> = {
  id: 'tls',
  version: '2.0.0',
  inputSchema: {version: '1.0', additionalProperties: false, fields: [
    {name: 'certificatePath', type: 'string', required: true, description: 'Existing PEM certificate-chain file path.'},
    {name: 'privateKeyPath', type: 'string', required: true, description: 'Existing PEM private-key file path.'},
    {name: 'redirectHttp', type: 'boolean', required: false, description: 'Create an HTTP server that redirects to the configured HTTPS server.'},
  ]},
  dependencies: ['reverse-proxy'],
  incompatibleWith: [],
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

const definitions = deepFreeze({reverseProxy, routing, tls, websocket} as const);

export function getCapabilityDefinition(id: string): NginxCapabilityDefinition | undefined {
  return Object.values(definitions).find(definition => definition.id === id);
}

export function listCapabilityDefinitions(): readonly NginxCapabilityDefinition[] {
  return Object.values(definitions);
}
