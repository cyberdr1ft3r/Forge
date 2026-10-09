import type {Diagnostic, OutputArtifact, ValidationSummary} from '../core/types.js';
import type {DirectiveNode, NginxNode, NginxOutputProfile, NginxSourceProvenance} from '../nginx-syntax/types.js';

export type NginxCapabilityId = 'reverse-proxy' | 'routing' | 'static-site' | 'tls' | 'upstream-load-balancing' | 'websocket';
export type NginxModule = 'http_map' | 'http_proxy' | 'http_rewrite' | 'http_ssl';

export interface CapabilityInputFieldSchema {
  readonly name: string;
  readonly type: 'string' | 'integer' | 'boolean' | 'enum' | 'array';
  readonly required: boolean;
  readonly description: string;
  readonly values?: readonly string[];
  readonly maximumItems?: number;
}

export interface CapabilityInputSchema {
  readonly version: string;
  readonly additionalProperties: false;
  readonly fields: readonly CapabilityInputFieldSchema[];
}

export interface CapabilityRequirement {
  readonly minimumNginxVersion: string;
  readonly modules: readonly NginxModule[];
}

export interface CapabilityAstSurface {
  readonly contexts: readonly ('http' | 'server' | 'location' | 'upstream')[];
  readonly directives: readonly string[];
  readonly blocks: readonly ('map' | 'server' | 'location' | 'upstream')[];
}

export interface CapabilityValidationSuccess<TInput> {
  readonly ok: true;
  readonly value: TInput;
  readonly diagnostics: readonly [];
}

export interface CapabilityValidationFailure {
  readonly ok: false;
  readonly diagnostics: readonly Diagnostic[];
}

export type CapabilityValidation<TInput> = CapabilityValidationSuccess<TInput> | CapabilityValidationFailure;

export interface PlannedRoute {
  readonly prefix: string;
  readonly target:
    | {readonly kind: 'direct'; readonly host: string; readonly port: number}
    | {readonly kind: 'upstream'; readonly id: string; readonly nginxName: string};
  readonly forwarding: 'preserve-prefix' | 'strip-prefix';
  readonly source: NginxSourceProvenance;
}

export interface TlsContribution {
  readonly directives: readonly DirectiveNode[];
  readonly redirectHttp: boolean;
  readonly source: NginxSourceProvenance;
}

export interface StaticSiteContribution {
  readonly serverDirectives: readonly DirectiveNode[];
  readonly rootLocation: NginxNode;
  readonly spaFallback: boolean;
  readonly source: NginxSourceProvenance;
}

export interface CapabilityContribution {
  readonly domain?: string;
  readonly routes?: readonly PlannedRoute[];
  readonly tls?: TlsContribution;
  readonly websocketRoutes?: readonly string[];
  readonly sharedHttpNodes?: readonly NginxNode[];
  readonly staticSite?: StaticSiteContribution;
  readonly prerequisites?: readonly CompositionPrerequisite[];
  readonly explanations?: readonly CompositionExplanation[];
}

export interface NginxCapabilityDefinition<TInput = unknown> {
  readonly id: NginxCapabilityId;
  readonly version: string;
  readonly inputSchema: CapabilityInputSchema;
  readonly dependencies: readonly NginxCapabilityId[];
  readonly incompatibleWith: readonly NginxCapabilityId[];
  /** True when this capability augments either trusted site owner instead of requiring one specific owner ID. */
  readonly requiresSiteOwner: boolean;
  readonly astSurface: CapabilityAstSurface;
  requirements(input: TInput): CapabilityRequirement;
  validate(input: unknown, path: string): CapabilityValidation<TInput>;
  contribute(input: TInput): CapabilityContribution;
}

export interface CapabilitySelection {
  readonly id: string;
  readonly input: unknown;
}

export interface NginxTarget {
  readonly version: string;
  readonly modules: readonly string[];
}

export interface NginxCompositionRequest {
  readonly profile: NginxOutputProfile;
  readonly target: NginxTarget;
  readonly capabilities: readonly CapabilitySelection[];
}

export interface NginxSiteDefinition {
  readonly id: string;
  readonly capabilities: readonly CapabilitySelection[];
}

/** Additive multi-site API. The legacy NginxCompositionRequest remains unchanged. */
export interface NginxMultiSiteCompositionRequest {
  readonly profile: NginxOutputProfile;
  readonly target: NginxTarget;
  readonly sites: readonly NginxSiteDefinition[];
}

export interface CompositionExplanation {
  readonly code: string;
  readonly capabilityId: NginxCapabilityId;
  readonly message: string;
  readonly context: 'http' | 'server' | 'location' | 'upstream' | 'artifact';
  readonly semanticIdentity?: string;
  readonly siteId?: string;
  readonly siteIds?: readonly string[];
}

export interface CompositionPrerequisite {
  readonly code: string;
  readonly capabilityId: NginxCapabilityId;
  readonly kind: 'directory' | 'file' | 'module' | 'operator-action' | 'service';
  readonly description: string;
  readonly path?: string;
  readonly siteId?: string;
}

export interface NginxCompositionSuccess {
  readonly ok: true;
  readonly artifacts: readonly OutputArtifact[];
  readonly diagnostics: readonly Diagnostic[];
  readonly explanations: readonly CompositionExplanation[];
  readonly prerequisites: readonly CompositionPrerequisite[];
  readonly validation: ValidationSummary;
  readonly provenance: {
    readonly generatedBy: 'Forge';
    readonly engine: 'nginx-capability-composition';
    readonly version: '2.0.0' | '2.1.0' | '2.2.0';
    readonly deterministic: true;
    readonly capabilities: readonly {readonly id: NginxCapabilityId; readonly version: string}[];
    readonly sites?: readonly string[];
  };
}

export interface NginxCompositionFailure {
  readonly ok: false;
  readonly artifacts: readonly [];
  readonly diagnostics: readonly Diagnostic[];
  readonly explanations: readonly CompositionExplanation[];
  readonly prerequisites: readonly CompositionPrerequisite[];
  readonly validation: ValidationSummary;
  readonly provenance: NginxCompositionSuccess['provenance'];
}

export type NginxCompositionOutcome = NginxCompositionSuccess | NginxCompositionFailure;

export interface ReverseProxyDirectInput {
  readonly domain: string;
  readonly targetHost: string;
  readonly targetPort: number;
}

export interface ReverseProxyUpstreamInput {
  readonly domain: string;
  readonly upstreamId: string;
}

export type ReverseProxyInput = ReverseProxyDirectInput | ReverseProxyUpstreamInput;

export interface RouteInput {
  readonly prefix: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly forwarding: 'preserve-prefix' | 'strip-prefix';
}

export interface RoutingInput {
  readonly routes: readonly RouteInput[];
}

export interface TlsInput {
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly redirectHttp: boolean;
}

export interface WebSocketInput {
  readonly routes: readonly string[];
}

export interface StaticSiteInput {
  readonly domain: string;
  readonly documentRoot: string;
  readonly indexFile: string;
  readonly spaFallback: boolean;
}

export type UpstreamLoadBalancingStrategy = 'round-robin' | 'least-connections';

export interface UpstreamBackendInput {
  readonly host: string;
  readonly port: number;
  readonly weight: number;
  readonly maxFails: number;
  readonly failTimeoutSeconds: number;
  readonly backup: boolean;
  readonly down: boolean;
}

export interface UpstreamLoadBalancingInput {
  readonly upstreamId: string;
  readonly strategy: UpstreamLoadBalancingStrategy;
  readonly backends: readonly UpstreamBackendInput[];
}

export interface DependencyNode {
  readonly id: string;
  readonly dependencies: readonly string[];
}
