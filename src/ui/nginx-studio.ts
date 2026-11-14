import type {CapabilitySelection, NginxMultiSiteCompositionRequest} from '../nginx-composition/types.js';

export type NginxStudioMode = 'basic' | 'advanced';
export type NginxSiteWorkflow = 'reverse-proxy' | 'static-site';

export interface NginxStudioRoute {
  key: string;
  prefix: string;
  targetHost: string;
  targetPort: string;
  forwarding: 'preserve-prefix' | 'strip-prefix';
  websocket: boolean;
}

export interface NginxStudioBackend {
  key: string;
  host: string;
  port: string;
  weight: string;
  maxFails: string;
  failTimeoutSeconds: string;
  backup: boolean;
  down: boolean;
}

export interface NginxStudioSite {
  key: string;
  id: string;
  workflow: NginxSiteWorkflow;
  domain: string;
  targetHost: string;
  targetPort: string;
  rootWebsocket: boolean;
  routes: NginxStudioRoute[];
  useUpstream: boolean;
  upstreamId: string;
  upstreamStrategy: 'round-robin' | 'least-connections';
  backends: NginxStudioBackend[];
  documentRoot: string;
  indexFile: string;
  spaFallback: boolean;
  tls: boolean;
  certificatePath: string;
  privateKeyPath: string;
  redirectHttp: boolean;
  logging: boolean;
  accessLog: 'combined' | 'forge-json' | 'off';
  accessLogPath: string;
  errorLogPath: string;
  errorLogLevel: 'info' | 'notice' | 'warn' | 'error' | 'crit' | 'alert' | 'emerg';
  requestLimit: boolean;
  connectionLimit: boolean;
  policyId: string;
  requestRate: string;
  requestUnit: 'second' | 'minute';
  requestBurst: string;
  requestNoDelay: boolean;
  requestZoneMb: string;
  requestStatus: '429' | '503';
  connectionCount: string;
  connectionZoneMb: string;
  connectionStatus: '429' | '503';
}

export interface NginxStudioState {
  mode: NginxStudioMode;
  profile: 'full-config' | 'site-fragment';
  sites: NginxStudioSite[];
}

export interface NginxStudioRequestBuild {
  readonly request: NginxMultiSiteCompositionRequest;
  readonly diagnosticTargets: ReadonlyMap<string, string>;
}

export const NGINX_STUDIO_TARGET_VERSION = '1.26.3';
export const NGINX_STUDIO_TARGET_MODULES = ['http_limit_conn', 'http_limit_req', 'http_log', 'http_map', 'http_proxy', 'http_rewrite', 'http_ssl'] as const;
export const NGINX_STUDIO_LIMITS = {sites: 16, routesPerSite: 32, backendsPerUpstream: 16} as const;

export function nginxControlId(key: string, field: string): string {
  return `nginx-${key.replace(/[^a-zA-Z0-9_-]/gu, '-')}-${field}`;
}

export function createNginxRoute(key: string): NginxStudioRoute {
  return {key, prefix: '/api/', targetHost: '127.0.0.1', targetPort: '3001', forwarding: 'preserve-prefix', websocket: false};
}

export function createNginxBackend(key: string, ordinal: number): NginxStudioBackend {
  return {key, host: '127.0.0.1', port: String(3000 + ordinal), weight: '1', maxFails: '1', failTimeoutSeconds: '10', backup: false, down: false};
}

export function createNginxSite(key: string, ordinal: number): NginxStudioSite {
  const siteId = ordinal === 1 ? 'app' : `app-${ordinal}`;
  const domain = ordinal === 1 ? 'app.example.com' : `app-${ordinal}.example.com`;
  return {
    key, id: siteId, workflow: 'reverse-proxy', domain, targetHost: '127.0.0.1', targetPort: String(2999 + ordinal), rootWebsocket: false,
    routes: [], useUpstream: false, upstreamId: `${siteId}-pool`, upstreamStrategy: 'round-robin',
    backends: [createNginxBackend(`${key}-backend-1`, 1), createNginxBackend(`${key}-backend-2`, 2)],
    documentRoot: `/var/www/${siteId}`, indexFile: 'index.html', spaFallback: false,
    tls: false, certificatePath: `/etc/nginx/certs/${domain}.pem`, privateKeyPath: `/etc/nginx/private/${domain}.key`, redirectHttp: true,
    logging: false, accessLog: 'combined', accessLogPath: `/var/log/nginx/${siteId}-access.log`, errorLogPath: `/var/log/nginx/${siteId}-error.log`, errorLogLevel: 'error',
    requestLimit: false, connectionLimit: false, policyId: siteId, requestRate: '10', requestUnit: 'second', requestBurst: '20', requestNoDelay: true,
    requestZoneMb: '10', requestStatus: '429', connectionCount: '100', connectionZoneMb: '10', connectionStatus: '429',
  };
}

export function createDefaultNginxStudioState(): NginxStudioState {
  return {mode: 'basic', profile: 'full-config', sites: [createNginxSite('site-1', 1)]};
}

function numeric(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

function mapTarget(targets: Map<string, string>, path: string, key: string, field: string): void {
  targets.set(path, nginxControlId(key, field));
}

export function buildNginxStudioRequest(state: Readonly<NginxStudioState>): NginxStudioRequestBuild {
  const diagnosticTargets = new Map<string, string>();
  const sites = state.sites.map((site, siteIndex) => {
    const sitePath = `request.sites[${siteIndex}]`;
    mapTarget(diagnosticTargets, `${sitePath}.id`, site.key, 'id');
    mapTarget(diagnosticTargets, `${sitePath}.capabilities`, site.key, 'workflow');
    const capabilities: CapabilitySelection[] = [];

    const addCapability = (id: string, input: unknown, fields: Readonly<Record<string, readonly [string, string]>> = {}): number => {
      const index = capabilities.length;
      capabilities.push({id, input});
      const inputPath = `${sitePath}.capabilities[${index}].input`;
      for (const [fieldPath, [key, field]] of Object.entries(fields)) mapTarget(diagnosticTargets, `${inputPath}.${fieldPath}`, key, field);
      diagnosticTargets.set(inputPath, nginxControlId(site.key, 'workflow'));
      return index;
    };

    if (site.workflow === 'static-site') {
      addCapability('static-site', {
        domain: site.domain, documentRoot: site.documentRoot, indexFile: site.indexFile, spaFallback: site.spaFallback,
      }, {
        domain: [site.key, 'domain'], documentRoot: [site.key, 'documentRoot'], indexFile: [site.key, 'indexFile'], spaFallback: [site.key, 'spaFallback'],
      });
    } else {
      addCapability('reverse-proxy', site.useUpstream
        ? {domain: site.domain, upstreamId: site.upstreamId}
        : {domain: site.domain, targetHost: site.targetHost, targetPort: numeric(site.targetPort)}, {
        domain: [site.key, 'domain'], upstreamId: [site.key, 'upstreamId'], targetHost: [site.key, 'targetHost'], targetPort: [site.key, 'targetPort'],
      });
      if (site.useUpstream) {
        const upstreamIndex = addCapability('upstream-load-balancing', {
          upstreamId: site.upstreamId,
          strategy: site.upstreamStrategy,
          backends: site.backends.map(backend => ({
            host: backend.host, port: numeric(backend.port), weight: numeric(backend.weight), maxFails: numeric(backend.maxFails),
            failTimeoutSeconds: numeric(backend.failTimeoutSeconds), backup: backend.backup, down: backend.down,
          })),
        }, {upstreamId: [site.key, 'upstreamId'], strategy: [site.key, 'upstreamStrategy'], backends: [site.key, 'backends']});
        site.backends.forEach((backend, backendIndex) => {
          const prefix = `${sitePath}.capabilities[${upstreamIndex}].input.backends[${backendIndex}]`;
          for (const field of ['host', 'port', 'weight', 'maxFails', 'failTimeoutSeconds', 'backup', 'down']) mapTarget(diagnosticTargets, `${prefix}.${field}`, backend.key, field);
          mapTarget(diagnosticTargets, `${prefix}.targetHost`, backend.key, 'host');
          mapTarget(diagnosticTargets, `${prefix}.targetPort`, backend.key, 'port');
          diagnosticTargets.set(prefix, nginxControlId(backend.key, 'host'));
        });
      }
      if (site.routes.length > 0) {
        const routingIndex = addCapability('routing', {routes: site.routes.map(route => ({
          prefix: route.prefix, targetHost: route.targetHost, targetPort: numeric(route.targetPort), forwarding: route.forwarding,
        }))}, {routes: [site.key, 'routes']});
        site.routes.forEach((route, routeIndex) => {
          const prefix = `${sitePath}.capabilities[${routingIndex}].input.routes[${routeIndex}]`;
          for (const field of ['prefix', 'targetHost', 'targetPort', 'forwarding']) mapTarget(diagnosticTargets, `${prefix}.${field}`, route.key, field);
          diagnosticTargets.set(prefix, nginxControlId(route.key, 'prefix'));
        });
      }
      const websocketRoutes = [
        ...(site.rootWebsocket ? ['/'] : []),
        ...site.routes.filter(route => route.websocket).map(route => route.prefix),
      ];
      if (websocketRoutes.length > 0) addCapability('websocket', {routes: websocketRoutes}, {routes: [site.key, 'rootWebsocket']});
    }

    if (site.tls) addCapability('tls', {
      certificatePath: site.certificatePath, privateKeyPath: site.privateKeyPath, redirectHttp: site.redirectHttp,
    }, {certificatePath: [site.key, 'certificatePath'], privateKeyPath: [site.key, 'privateKeyPath'], redirectHttp: [site.key, 'redirectHttp']});

    if (site.logging) addCapability('logging', {
      accessLog: site.accessLog,
      ...(site.accessLog === 'off' ? {} : {accessLogPath: site.accessLogPath}),
      errorLogPath: site.errorLogPath,
      errorLogLevel: site.errorLogLevel,
    }, {accessLog: [site.key, 'accessLog'], accessLogPath: [site.key, 'accessLogPath'], errorLogPath: [site.key, 'errorLogPath'], errorLogLevel: [site.key, 'errorLogLevel']});

    if (site.requestLimit || site.connectionLimit) addCapability('traffic-limiting', {
      policyId: site.policyId,
      ...(site.requestLimit ? {requestLimit: {
        rate: numeric(site.requestRate), unit: site.requestUnit, burst: numeric(site.requestBurst), nodelay: site.requestNoDelay,
        zoneSizeMb: numeric(site.requestZoneMb), statusCode: numeric(site.requestStatus),
      }} : {}),
      ...(site.connectionLimit ? {connectionLimit: {
        connections: numeric(site.connectionCount), zoneSizeMb: numeric(site.connectionZoneMb), statusCode: numeric(site.connectionStatus),
      }} : {}),
    }, {
      policyId: [site.key, 'policyId'], 'requestLimit.rate': [site.key, 'requestRate'], 'requestLimit.unit': [site.key, 'requestUnit'],
      'requestLimit.burst': [site.key, 'requestBurst'], 'requestLimit.nodelay': [site.key, 'requestNoDelay'], 'requestLimit.zoneSizeMb': [site.key, 'requestZoneMb'],
      'requestLimit.statusCode': [site.key, 'requestStatus'], 'connectionLimit.connections': [site.key, 'connectionCount'],
      'connectionLimit.zoneSizeMb': [site.key, 'connectionZoneMb'], 'connectionLimit.statusCode': [site.key, 'connectionStatus'],
    });

    return {id: site.id, capabilities};
  });

  return {
    request: {profile: state.profile, target: {version: NGINX_STUDIO_TARGET_VERSION, modules: NGINX_STUDIO_TARGET_MODULES}, sites},
    diagnosticTargets,
  };
}

export function diagnosticTarget(path: string | undefined, targets: ReadonlyMap<string, string>): string | undefined {
  if (path === undefined) return undefined;
  let candidate = path;
  while (candidate.length > 0) {
    const target = targets.get(candidate);
    if (target !== undefined) return target;
    const next = candidate.replace(/(?:\.[^.\[]+|\[\d+\])$/u, '');
    if (next === candidate) break;
    candidate = next;
  }
  return undefined;
}
