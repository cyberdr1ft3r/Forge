import type {Diagnostic, OutputArtifact} from '../core/types.js';

export type NginxContext = 'main' | 'events' | 'http' | 'server' | 'location' | 'upstream' | 'map';
export type NginxBlockType = Exclude<NginxContext, 'main'>;
export type NginxOutputProfile = 'full-config' | 'site-fragment';
export type NginxArgumentKind =
  | 'literal'
  | 'identifier'
  | 'integer'
  | 'domain'
  | 'directory-path'
  | 'path'
  | 'file-path'
  | 'index-file'
  | 'log-format-name'
  | 'log-format-template'
  | 'request-limit-zone-definition'
  | 'connection-limit-zone-definition'
  | 'request-limit-zone-reference'
  | 'connection-limit-zone-name'
  | 'request-limit-rate'
  | 'request-limit-burst'
  | 'proxy-url'
  | 'upstream-url'
  | 'redirect-url'
  | 'try-file-candidate'
  | 'try-file-fallback'
  | 'upstream-address'
  | 'upstream-parameter'
  | 'location-prefix'
  | 'variable'
  | 'keyword'
  | 'header-name'
  | 'quoted';

export type KnownNginxVariable =
  | '$binary_remote_addr'
  | '$connection_upgrade'
  | '$host'
  | '$http_upgrade'
  | '$proxy_add_x_forwarded_for'
  | '$remote_addr'
  | '$request_uri'
  | '$scheme'
  | '$uri';

export interface NginxSourceProvenance {
  readonly kind: 'engine' | 'generator' | 'capability';
  readonly id: string;
  readonly version?: string;
  /** Stable owning site for nodes produced by multi-site composition. */
  readonly siteId?: string;
}

export type NginxArgument =
  | {readonly kind: 'integer'; readonly value: number}
  | {readonly kind: 'variable'; readonly value: KnownNginxVariable}
  | {readonly kind: Exclude<NginxArgumentKind, 'integer' | 'variable'>; readonly value: string};

export type KnownDirectiveName =
  | 'access_log'
  | 'daemon'
  | 'default_type'
  | 'error_log'
  | 'include'
  | 'index'
  | 'keepalive'
  | 'least_conn'
  | 'limit_conn'
  | 'limit_conn_status'
  | 'limit_conn_zone'
  | 'limit_req'
  | 'limit_req_status'
  | 'limit_req_zone'
  | 'listen'
  | 'log_format'
  | 'pid'
  | 'proxy_pass'
  | 'proxy_http_version'
  | 'proxy_set_header'
  | 'return'
  | 'root'
  | 'server_name'
  | 'server_tokens'
  | 'ssl_certificate'
  | 'ssl_certificate_key'
  | 'ssl_protocols'
  | 'try_files'
  | 'upstream_server'
  | 'user'
  | 'worker_connections'
  | 'worker_processes';

export interface DirectiveNode {
  readonly kind: 'directive';
  readonly name: KnownDirectiveName;
  readonly args: readonly NginxArgument[];
  readonly source: NginxSourceProvenance;
}

export interface MapEntryNode {
  readonly kind: 'map-entry';
  readonly key: NginxArgument;
  readonly value: NginxArgument;
  readonly source: NginxSourceProvenance;
}

export interface BlockNode<TBlock extends NginxBlockType = NginxBlockType> {
  readonly kind: 'block';
  readonly blockType: TBlock;
  readonly header: readonly NginxArgument[];
  readonly children: readonly NginxNode[];
  readonly source: NginxSourceProvenance;
}

export type NginxNode = DirectiveNode | MapEntryNode | BlockNode;

export interface NginxDocument {
  readonly profile: NginxOutputProfile;
  readonly children: readonly NginxNode[];
  readonly source: NginxSourceProvenance;
}

export interface NginxCompilationSuccess {
  readonly ok: true;
  readonly artifacts: readonly OutputArtifact[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface NginxCompilationFailure {
  readonly ok: false;
  readonly artifacts: readonly [];
  readonly diagnostics: readonly Diagnostic[];
}

export type NginxCompilation = NginxCompilationSuccess | NginxCompilationFailure;

export const FORGE_JSON_LOG_FORMAT_NAME = 'forge_json_v1';
export const FORGE_JSON_LOG_FORMAT_TEMPLATE = '{"time":"$time_iso8601","remote_addr":"$remote_addr","host":"$host","method":"$request_method","uri":"$uri","status":$status,"bytes_sent":$body_bytes_sent,"request_time":$request_time}';

export const nginxArgument = Object.freeze({
  literal: (value: string): NginxArgument => ({kind: 'literal', value}),
  identifier: (value: string): NginxArgument => ({kind: 'identifier', value}),
  integer: (value: number): NginxArgument => ({kind: 'integer', value}),
  domain: (value: string): NginxArgument => ({kind: 'domain', value}),
  directoryPath: (value: string): NginxArgument => ({kind: 'directory-path', value}),
  path: (value: string): NginxArgument => ({kind: 'path', value}),
  filePath: (value: string): NginxArgument => ({kind: 'file-path', value}),
  indexFile: (value: string): NginxArgument => ({kind: 'index-file', value}),
  logFormatName: (value: string): NginxArgument => ({kind: 'log-format-name', value}),
  logFormatTemplate: (value: string): NginxArgument => ({kind: 'log-format-template', value}),
  requestLimitZoneDefinition: (value: string): NginxArgument => ({kind: 'request-limit-zone-definition', value}),
  connectionLimitZoneDefinition: (value: string): NginxArgument => ({kind: 'connection-limit-zone-definition', value}),
  requestLimitZoneReference: (value: string): NginxArgument => ({kind: 'request-limit-zone-reference', value}),
  connectionLimitZoneName: (value: string): NginxArgument => ({kind: 'connection-limit-zone-name', value}),
  requestLimitRate: (value: string): NginxArgument => ({kind: 'request-limit-rate', value}),
  requestLimitBurst: (value: string): NginxArgument => ({kind: 'request-limit-burst', value}),
  proxyUrl: (value: string): NginxArgument => ({kind: 'proxy-url', value}),
  upstreamUrl: (value: string): NginxArgument => ({kind: 'upstream-url', value}),
  redirectUrl: (value: string): NginxArgument => ({kind: 'redirect-url', value}),
  tryFileCandidate: (value: '$uri' | '$uri/'): NginxArgument => ({kind: 'try-file-candidate', value}),
  tryFileFallback: (value: string): NginxArgument => ({kind: 'try-file-fallback', value}),
  upstreamAddress: (value: string): NginxArgument => ({kind: 'upstream-address', value}),
  upstreamParameter: (value: string): NginxArgument => ({kind: 'upstream-parameter', value}),
  locationPrefix: (value: string): NginxArgument => ({kind: 'location-prefix', value}),
  variable: (value: KnownNginxVariable): NginxArgument => ({kind: 'variable', value}),
  keyword: (value: string): NginxArgument => ({kind: 'keyword', value}),
  headerName: (value: string): NginxArgument => ({kind: 'header-name', value}),
  quoted: (value: string): NginxArgument => ({kind: 'quoted', value}),
} as const);

export function directive(name: KnownDirectiveName, args: readonly NginxArgument[], source: NginxSourceProvenance): DirectiveNode {
  return {kind: 'directive', name, args, source};
}

export function block<TBlock extends NginxBlockType>(blockType: TBlock, header: readonly NginxArgument[], children: readonly NginxNode[], source: NginxSourceProvenance): BlockNode<TBlock> {
  return {kind: 'block', blockType, header, children, source};
}

export function mapEntry(key: NginxArgument, value: NginxArgument, source: NginxSourceProvenance): MapEntryNode {
  return {kind: 'map-entry', key, value, source};
}
