import type {KnownDirectiveName, NginxArgumentKind, NginxBlockType, NginxContext} from './types.js';

export interface ArgumentRule {
  readonly kinds: readonly NginxArgumentKind[];
  readonly optional?: boolean;
  readonly variadic?: boolean;
  readonly keywords?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface DirectiveDefinition {
  readonly id: KnownDirectiveName;
  readonly nginxName: string;
  readonly contexts: readonly NginxContext[];
  readonly arguments: readonly ArgumentRule[];
  readonly repeatability: 'single' | 'repeatable' | 'keyed';
  readonly identityArgument?: number;
  readonly order: number;
}

export interface BlockDefinition {
  readonly blockType: NginxBlockType;
  readonly parents: readonly NginxContext[];
  readonly header: readonly ArgumentRule[];
  readonly repeatability: 'single' | 'repeatable' | 'keyed';
  readonly order: number;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const directives = deepFreeze({
  access_log: {id: 'access_log', nginxName: 'access_log', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['file-path', 'keyword'], keywords: ['off']}, {kinds: ['log-format-name', 'keyword'], optional: true, keywords: ['combined']}], repeatability: 'single', order: 36},
  daemon: {id: 'daemon', nginxName: 'daemon', contexts: ['main'], arguments: [{kinds: ['keyword'], keywords: ['on', 'off']}], repeatability: 'single', order: 10},
  user: {id: 'user', nginxName: 'user', contexts: ['main'], arguments: [{kinds: ['identifier']}, {kinds: ['identifier'], optional: true}], repeatability: 'single', order: 20},
  worker_processes: {id: 'worker_processes', nginxName: 'worker_processes', contexts: ['main'], arguments: [{kinds: ['integer', 'keyword'], keywords: ['auto'], minimum: 1, maximum: 1024}], repeatability: 'single', order: 30},
  error_log: {id: 'error_log', nginxName: 'error_log', contexts: ['main', 'http', 'server', 'location'], arguments: [{kinds: ['file-path']}, {kinds: ['keyword'], optional: true, keywords: ['debug', 'info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg']}], repeatability: 'single', order: 40},
  pid: {id: 'pid', nginxName: 'pid', contexts: ['main'], arguments: [{kinds: ['path']}], repeatability: 'single', order: 50},
  include: {id: 'include', nginxName: 'include', contexts: ['main', 'http', 'server', 'location'], arguments: [{kinds: ['path', 'file-path']}], repeatability: 'repeatable', order: 60},
  worker_connections: {id: 'worker_connections', nginxName: 'worker_connections', contexts: ['events'], arguments: [{kinds: ['integer'], minimum: 1, maximum: 1_000_000}], repeatability: 'single', order: 100},
  default_type: {id: 'default_type', nginxName: 'default_type', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['literal']}], repeatability: 'single', order: 200},
  server_tokens: {id: 'server_tokens', nginxName: 'server_tokens', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['keyword'], keywords: ['on', 'off']}], repeatability: 'single', order: 210},
  root: {id: 'root', nginxName: 'root', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['directory-path', 'path']}], repeatability: 'single', order: 220},
  index: {id: 'index', nginxName: 'index', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['index-file', 'literal'], variadic: true}], repeatability: 'single', order: 230},
  try_files: {id: 'try_files', nginxName: 'try_files', contexts: ['server', 'location'], arguments: [{kinds: ['try-file-candidate']}, {kinds: ['try-file-candidate']}, {kinds: ['try-file-fallback']}], repeatability: 'single', order: 380},
  listen: {id: 'listen', nginxName: 'listen', contexts: ['server'], arguments: [{kinds: ['integer'], minimum: 1, maximum: 65_535}, {kinds: ['keyword'], optional: true, keywords: ['default_server', 'ssl']}], repeatability: 'keyed', order: 300},
  log_format: {id: 'log_format', nginxName: 'log_format', contexts: ['http'], arguments: [{kinds: ['log-format-name']}, {kinds: ['keyword'], keywords: ['escape=json']}, {kinds: ['log-format-template']}], repeatability: 'keyed', order: 215},
  limit_req_zone: {id: 'limit_req_zone', nginxName: 'limit_req_zone', contexts: ['http'], arguments: [{kinds: ['variable']}, {kinds: ['request-limit-zone-definition']}, {kinds: ['request-limit-rate']}], repeatability: 'keyed', identityArgument: 1, order: 240},
  limit_conn_zone: {id: 'limit_conn_zone', nginxName: 'limit_conn_zone', contexts: ['http'], arguments: [{kinds: ['variable']}, {kinds: ['connection-limit-zone-definition']}], repeatability: 'keyed', identityArgument: 1, order: 250},
  server_name: {id: 'server_name', nginxName: 'server_name', contexts: ['server'], arguments: [{kinds: ['domain'], variadic: true}], repeatability: 'single', order: 310},
  return: {id: 'return', nginxName: 'return', contexts: ['server', 'location'], arguments: [{kinds: ['integer'], minimum: 100, maximum: 599}, {kinds: ['redirect-url']}], repeatability: 'single', order: 320},
  ssl_certificate: {id: 'ssl_certificate', nginxName: 'ssl_certificate', contexts: ['http', 'server'], arguments: [{kinds: ['file-path']}], repeatability: 'single', order: 330},
  ssl_certificate_key: {id: 'ssl_certificate_key', nginxName: 'ssl_certificate_key', contexts: ['http', 'server'], arguments: [{kinds: ['file-path']}], repeatability: 'single', order: 340},
  ssl_protocols: {id: 'ssl_protocols', nginxName: 'ssl_protocols', contexts: ['http', 'server'], arguments: [{kinds: ['keyword'], keywords: ['TLSv1.2', 'TLSv1.3'], variadic: true}], repeatability: 'single', order: 350},
  limit_req: {id: 'limit_req', nginxName: 'limit_req', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['request-limit-zone-reference']}, {kinds: ['request-limit-burst'], optional: true}, {kinds: ['keyword'], optional: true, keywords: ['nodelay']}], repeatability: 'single', order: 360},
  limit_req_status: {id: 'limit_req_status', nginxName: 'limit_req_status', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['integer'], minimum: 400, maximum: 599}], repeatability: 'single', order: 361},
  limit_conn: {id: 'limit_conn', nginxName: 'limit_conn', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['connection-limit-zone-name']}, {kinds: ['integer'], minimum: 1, maximum: 10_000}], repeatability: 'single', order: 362},
  limit_conn_status: {id: 'limit_conn_status', nginxName: 'limit_conn_status', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['integer'], minimum: 400, maximum: 599}], repeatability: 'single', order: 363},
  proxy_http_version: {id: 'proxy_http_version', nginxName: 'proxy_http_version', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['keyword'], keywords: ['1.1']}], repeatability: 'single', order: 390},
  proxy_pass: {id: 'proxy_pass', nginxName: 'proxy_pass', contexts: ['location'], arguments: [{kinds: ['proxy-url', 'upstream-url']}], repeatability: 'single', order: 400},
  proxy_set_header: {id: 'proxy_set_header', nginxName: 'proxy_set_header', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['header-name']}, {kinds: ['literal', 'variable', 'quoted']}], repeatability: 'keyed', order: 410},
  least_conn: {id: 'least_conn', nginxName: 'least_conn', contexts: ['upstream'], arguments: [], repeatability: 'single', order: 490},
  upstream_server: {id: 'upstream_server', nginxName: 'server', contexts: ['upstream'], arguments: [{kinds: ['upstream-address']}, {kinds: ['upstream-parameter'], optional: true, variadic: true}], repeatability: 'keyed', order: 500},
  keepalive: {id: 'keepalive', nginxName: 'keepalive', contexts: ['upstream'], arguments: [{kinds: ['integer'], minimum: 1, maximum: 65_535}], repeatability: 'single', order: 510},
} as const satisfies Record<KnownDirectiveName, DirectiveDefinition>);

const blocks = deepFreeze({
  events: {blockType: 'events', parents: ['main'], header: [], repeatability: 'single', order: 100},
  http: {blockType: 'http', parents: ['main'], header: [], repeatability: 'single', order: 200},
  map: {blockType: 'map', parents: ['http'], header: [{kinds: ['variable']}, {kinds: ['variable']}], repeatability: 'keyed', order: 300},
  upstream: {blockType: 'upstream', parents: ['http'], header: [{kinds: ['identifier']}], repeatability: 'keyed', order: 400},
  server: {blockType: 'server', parents: ['http'], header: [], repeatability: 'repeatable', order: 500},
  location: {blockType: 'location', parents: ['server'], header: [{kinds: ['location-prefix']}], repeatability: 'keyed', order: 600},
} as const satisfies Record<NginxBlockType, BlockDefinition>);

export function getDirectiveDefinition(name: string): DirectiveDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(directives, name) ? directives[name as KnownDirectiveName] : undefined;
}

export function getBlockDefinition(blockType: string): BlockDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(blocks, blockType) ? blocks[blockType as NginxBlockType] : undefined;
}

export function listDirectiveDefinitions(): readonly DirectiveDefinition[] {
  return Object.values(directives);
}

export function listBlockDefinitions(): readonly BlockDefinition[] {
  return Object.values(blocks);
}
