import type {Diagnostic, OutputArtifact} from '../core/types.js';

export type NginxContext = 'main' | 'events' | 'http' | 'server' | 'location' | 'upstream' | 'map';
export type NginxBlockType = Exclude<NginxContext, 'main'>;
export type NginxOutputProfile = 'full-config' | 'site-fragment';
export type NginxArgumentKind = 'literal' | 'identifier' | 'integer' | 'domain' | 'path' | 'endpoint' | 'variable' | 'keyword' | 'header-name' | 'quoted';

export type KnownNginxVariable =
  | '$connection_upgrade'
  | '$host'
  | '$http_upgrade'
  | '$proxy_add_x_forwarded_for'
  | '$remote_addr'
  | '$request_uri'
  | '$scheme';

export interface NginxSourceProvenance {
  readonly kind: 'engine' | 'generator' | 'capability';
  readonly id: string;
  readonly version?: string;
}

export type NginxArgument =
  | {readonly kind: 'integer'; readonly value: number}
  | {readonly kind: 'variable'; readonly value: KnownNginxVariable}
  | {readonly kind: Exclude<NginxArgumentKind, 'integer' | 'variable'>; readonly value: string};

export type KnownDirectiveName =
  | 'daemon'
  | 'default_type'
  | 'error_log'
  | 'include'
  | 'index'
  | 'keepalive'
  | 'listen'
  | 'pid'
  | 'proxy_pass'
  | 'proxy_set_header'
  | 'root'
  | 'server_name'
  | 'server_tokens'
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

export const nginxArgument = Object.freeze({
  literal: (value: string): NginxArgument => ({kind: 'literal', value}),
  identifier: (value: string): NginxArgument => ({kind: 'identifier', value}),
  integer: (value: number): NginxArgument => ({kind: 'integer', value}),
  domain: (value: string): NginxArgument => ({kind: 'domain', value}),
  path: (value: string): NginxArgument => ({kind: 'path', value}),
  endpoint: (value: string): NginxArgument => ({kind: 'endpoint', value}),
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
