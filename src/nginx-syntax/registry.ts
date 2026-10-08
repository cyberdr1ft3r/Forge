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
  daemon: {id: 'daemon', nginxName: 'daemon', contexts: ['main'], arguments: [{kinds: ['keyword'], keywords: ['on', 'off']}], repeatability: 'single', order: 10},
  user: {id: 'user', nginxName: 'user', contexts: ['main'], arguments: [{kinds: ['identifier']}, {kinds: ['identifier'], optional: true}], repeatability: 'single', order: 20},
  worker_processes: {id: 'worker_processes', nginxName: 'worker_processes', contexts: ['main'], arguments: [{kinds: ['integer', 'keyword'], keywords: ['auto'], minimum: 1, maximum: 1024}], repeatability: 'single', order: 30},
  error_log: {id: 'error_log', nginxName: 'error_log', contexts: ['main', 'http', 'server', 'location'], arguments: [{kinds: ['path']}, {kinds: ['keyword'], optional: true, keywords: ['debug', 'info', 'notice', 'warn', 'error', 'crit', 'alert', 'emerg']}], repeatability: 'single', order: 40},
  pid: {id: 'pid', nginxName: 'pid', contexts: ['main'], arguments: [{kinds: ['path']}], repeatability: 'single', order: 50},
  include: {id: 'include', nginxName: 'include', contexts: ['main', 'http', 'server', 'location'], arguments: [{kinds: ['path']}], repeatability: 'repeatable', order: 60},
  worker_connections: {id: 'worker_connections', nginxName: 'worker_connections', contexts: ['events'], arguments: [{kinds: ['integer'], minimum: 1, maximum: 1_000_000}], repeatability: 'single', order: 100},
  default_type: {id: 'default_type', nginxName: 'default_type', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['literal']}], repeatability: 'single', order: 200},
  server_tokens: {id: 'server_tokens', nginxName: 'server_tokens', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['keyword'], keywords: ['on', 'off']}], repeatability: 'single', order: 210},
  root: {id: 'root', nginxName: 'root', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['path']}], repeatability: 'single', order: 220},
  index: {id: 'index', nginxName: 'index', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['literal'], variadic: true}], repeatability: 'single', order: 230},
  listen: {id: 'listen', nginxName: 'listen', contexts: ['server'], arguments: [{kinds: ['integer'], minimum: 1, maximum: 65_535}, {kinds: ['keyword'], optional: true, keywords: ['default_server']}], repeatability: 'keyed', order: 300},
  server_name: {id: 'server_name', nginxName: 'server_name', contexts: ['server'], arguments: [{kinds: ['domain'], variadic: true}], repeatability: 'single', order: 310},
  proxy_pass: {id: 'proxy_pass', nginxName: 'proxy_pass', contexts: ['location'], arguments: [{kinds: ['endpoint']}], repeatability: 'single', order: 400},
  proxy_set_header: {id: 'proxy_set_header', nginxName: 'proxy_set_header', contexts: ['http', 'server', 'location'], arguments: [{kinds: ['header-name']}, {kinds: ['literal', 'variable', 'quoted']}], repeatability: 'keyed', order: 410},
  upstream_server: {id: 'upstream_server', nginxName: 'server', contexts: ['upstream'], arguments: [{kinds: ['endpoint']}], repeatability: 'keyed', order: 500},
  keepalive: {id: 'keepalive', nginxName: 'keepalive', contexts: ['upstream'], arguments: [{kinds: ['integer'], minimum: 1, maximum: 65_535}], repeatability: 'single', order: 510},
} as const satisfies Record<KnownDirectiveName, DirectiveDefinition>);

const blocks = deepFreeze({
  events: {blockType: 'events', parents: ['main'], header: [], repeatability: 'single', order: 100},
  http: {blockType: 'http', parents: ['main'], header: [], repeatability: 'single', order: 200},
  map: {blockType: 'map', parents: ['http'], header: [{kinds: ['variable']}, {kinds: ['variable']}], repeatability: 'keyed', order: 300},
  upstream: {blockType: 'upstream', parents: ['http'], header: [{kinds: ['identifier']}], repeatability: 'keyed', order: 400},
  server: {blockType: 'server', parents: ['http'], header: [], repeatability: 'repeatable', order: 500},
  location: {blockType: 'location', parents: ['server'], header: [{kinds: ['path']}], repeatability: 'keyed', order: 600},
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
