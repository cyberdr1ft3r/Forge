import {baseArtifactChecks} from '../core/validation.js';
import type {Diagnostic, OutputArtifact, ValidationRecord, ValidationSummary} from '../core/types.js';
import {serializeNginxDocument, serializeNginxHttpFragment} from '../nginx-syntax/serializer.js';
import {block, directive, nginxArgument as arg} from '../nginx-syntax/types.js';
import type {BlockNode, NginxNode, NginxSourceProvenance} from '../nginx-syntax/types.js';
import {getCapabilityDefinition} from './capabilities.js';
import type {
  CapabilityContribution,
  CompositionExplanation,
  CompositionPrerequisite,
  DependencyNode,
  NginxCapabilityDefinition,
  NginxCapabilityId,
  NginxCompositionOutcome,
  NginxCompositionRequest,
  NginxModule,
  PlannedRoute,
  StaticSiteContribution,
  TlsContribution,
} from './types.js';

const ENGINE_VERSION = '2.2.0' as const;
const knownModules = new Set<NginxModule>(['http_map', 'http_proxy', 'http_rewrite', 'http_ssl']);

const diagnostic = (code: string, message: string, path: string, stage: 'input' | 'static' | 'generation' = 'input'): Diagnostic => ({code, message, path, severity: 'error', stage});
const nativeUnavailable: ValidationRecord = {
  status: 'unavailable',
  validator: 'nginx -t',
  diagnostics: [{code: 'native.unavailable', severity: 'warning', stage: 'native', message: 'Forge structural validation passed; an Nginx parser did not run.'}],
};
const targetHostNotRun: ValidationRecord = {
  status: 'not-run',
  validator: 'target-host nginx readiness',
  diagnostics: [{
    code: 'target-host.not-run',
    severity: 'warning',
    stage: 'target-host',
    message: 'The target host, installed modules, certificates, filesystem, permissions, and external services were not inspected.',
  }],
};
const notRun: ValidationRecord = {status: 'not-run', diagnostics: []};

export interface DependencyResolution {
  readonly ok: boolean;
  readonly order: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export function resolveCapabilityOrder(nodes: readonly DependencyNode[], selectedIds: readonly string[]): DependencyResolution {
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const selected = new Set(selectedIds);
  const diagnostics: Diagnostic[] = [];
  const states = new Map<string, 'visiting' | 'visited'>();
  const order: string[] = [];

  const visit = (id: string, path: readonly string[]): void => {
    if (states.get(id) === 'visited') return;
    if (states.get(id) === 'visiting') {
      diagnostics.push(diagnostic('composition.dependency.cycle', `Capability dependency cycle detected: ${[...path, id].join(' -> ')}.`, 'capabilities'));
      return;
    }
    const node = nodeMap.get(id);
    if (node === undefined) {
      diagnostics.push(diagnostic('composition.capability.unknown', `Unknown capability in dependency graph: ${id}.`, 'capabilities'));
      return;
    }
    states.set(id, 'visiting');
    for (const dependency of [...node.dependencies].sort()) {
      if (!selected.has(dependency)) {
        diagnostics.push(diagnostic('composition.dependency.missing', `${id} requires the explicitly selected ${dependency} capability.`, `capabilities.${id}`));
        continue;
      }
      visit(dependency, [...path, id]);
    }
    states.set(id, 'visited');
    order.push(id);
  };

  for (const id of [...selected].sort()) visit(id, []);
  return {ok: diagnostics.length === 0, order: [...new Set(order)], diagnostics};
}

function provenance(capabilities: readonly {readonly definition: NginxCapabilityDefinition; readonly input: unknown}[]) {
  return {
    generatedBy: 'Forge' as const,
    engine: 'nginx-capability-composition' as const,
    version: ENGINE_VERSION,
    deterministic: true as const,
    capabilities: capabilities
      .map(item => ({id: item.definition.id, version: item.definition.version}))
      .sort((left, right) => left.id.localeCompare(right.id, 'en')),
  };
}

function failure(
  diagnostics: readonly Diagnostic[],
  capabilities: readonly {readonly definition: NginxCapabilityDefinition; readonly input: unknown}[],
  explanations: readonly CompositionExplanation[] = [],
  prerequisites: readonly CompositionPrerequisite[] = [],
  inputPassed = false,
): NginxCompositionOutcome {
  const inputDiagnostics = diagnostics.filter(item => item.stage === 'input');
  const staticDiagnostics = diagnostics.filter(item => item.stage === 'static');
  const validation: ValidationSummary = {
    input: inputPassed ? {status: 'passed', diagnostics: []} : {status: 'failed', diagnostics: inputDiagnostics},
    static: staticDiagnostics.length > 0 ? {status: 'failed', diagnostics: staticDiagnostics} : notRun,
    native: nativeUnavailable,
    targetHost: targetHostNotRun,
  };
  return {ok: false, artifacts: [], diagnostics: [...diagnostics, ...nativeUnavailable.diagnostics], explanations, prerequisites, validation, provenance: provenance(capabilities)};
}

function parseVersion(value: unknown, path: string): {readonly value?: readonly [number, number, number]; readonly diagnostic?: Diagnostic} {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return {diagnostic: diagnostic('composition.target.version', 'Target Nginx version must use major.minor.patch format.', path)};
  const numbers = value.split('.').map(Number);
  const major = numbers[0];
  const minor = numbers[1];
  const patch = numbers[2];
  return major === undefined || minor === undefined || patch === undefined
    ? {diagnostic: diagnostic('composition.target.version', 'Target Nginx version is invalid.', path)}
    : {value: [major, minor, patch]};
}

function versionAtLeast(actual: readonly [number, number, number], minimum: string): boolean {
  const required = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const current = actual[index] ?? 0;
    const expected = required[index] ?? 0;
    if (current > expected) return true;
    if (current < expected) return false;
  }
  return true;
}

function routeBlock(route: PlannedRoute, websocket: boolean, siteId?: string): BlockNode<'location'> {
  const proxyUrl = route.target.kind === 'direct'
    ? `http://${route.target.host}:${route.target.port}${route.forwarding === 'strip-prefix' ? '/' : ''}`
    : `http://${route.target.nginxName}${route.forwarding === 'strip-prefix' ? '/' : ''}`;
  const children: NginxNode[] = [
    directive('proxy_http_version', [arg.keyword('1.1')], route.source),
    directive('proxy_pass', [route.target.kind === 'direct' ? arg.proxyUrl(proxyUrl) : arg.upstreamUrl(proxyUrl)], route.source),
    directive('proxy_set_header', [arg.headerName('Host'), arg.variable('$host')], route.source),
    directive('proxy_set_header', [arg.headerName('X-Forwarded-For'), arg.variable('$proxy_add_x_forwarded_for')], route.source),
    directive('proxy_set_header', [arg.headerName('X-Forwarded-Proto'), arg.variable('$scheme')], route.source),
    directive('proxy_set_header', [arg.headerName('X-Real-IP'), arg.variable('$remote_addr')], route.source),
  ];
  if (websocket) {
    const websocketSource: NginxSourceProvenance = siteId === undefined
      ? {kind: 'capability', id: 'websocket', version: ENGINE_VERSION}
      : {kind: 'capability', id: 'websocket', version: ENGINE_VERSION, siteId};
    children.push(
      directive('proxy_set_header', [arg.headerName('Upgrade'), arg.variable('$http_upgrade')], websocketSource),
      directive('proxy_set_header', [arg.headerName('Connection'), arg.variable('$connection_upgrade')], websocketSource),
    );
  }
  return block('location', [arg.locationPrefix(route.prefix)], children, route.source);
}

export function applicationServers(
  domain: string,
  routes: readonly PlannedRoute[],
  websocketRoutes: ReadonlySet<string>,
  tls: TlsContribution | undefined,
  siteId?: string,
  staticSite?: StaticSiteContribution,
): readonly BlockNode<'server'>[] {
  const reverseSource: NginxSourceProvenance = siteId === undefined
    ? {kind: 'capability', id: 'reverse-proxy', version: ENGINE_VERSION}
    : {kind: 'capability', id: 'reverse-proxy', version: ENGINE_VERSION, siteId};
  const routeNodes = routes.map(route => routeBlock(route, websocketRoutes.has(route.prefix), siteId));
  const ownerSource = staticSite?.source ?? reverseSource;
  const applicationNodes: readonly NginxNode[] = staticSite === undefined
    ? routeNodes
    : [...staticSite.serverDirectives, staticSite.rootLocation];
  if (tls === undefined) {
    return [block('server', [], [
      directive('listen', [arg.integer(80)], ownerSource),
      directive('server_name', [arg.domain(domain)], ownerSource),
      ...applicationNodes,
    ], ownerSource)];
  }

  const secure = block('server', [], [
    directive('listen', [arg.integer(443), arg.keyword('ssl')], tls.source),
    directive('server_name', [arg.domain(domain)], ownerSource),
    ...tls.directives,
    ...applicationNodes,
  ], tls.source);
  if (!tls.redirectHttp) return [secure];
  const redirect = block('server', [], [
    directive('listen', [arg.integer(80)], tls.source),
    directive('server_name', [arg.domain(domain)], ownerSource),
    directive('return', [arg.integer(301), arg.redirectUrl(`https://${domain}$request_uri`)], tls.source),
  ], tls.source);
  return [redirect, secure];
}

function semanticHttpIdentity(node: NginxNode): string {
  if (node.kind === 'block' && node.blockType === 'map') return `map:${String(node.header[1]?.value)}`;
  if (node.kind === 'block' && node.blockType === 'upstream') return `upstream:${String(node.header[0]?.value)}`;
  return `${node.kind}:${node.kind === 'directive' ? node.name : node.kind === 'block' ? node.blockType : String(node.key.value)}`;
}

function semanticNodeShape(node: NginxNode): string {
  return JSON.stringify(node, (key, value: unknown) => key === 'source' ? undefined : value);
}

function sortExplanations(explanations: CompositionExplanation[]): void {
  explanations.sort((left, right) => `${left.capabilityId}:${left.context}:${left.semanticIdentity ?? ''}:${left.code}`.localeCompare(`${right.capabilityId}:${right.context}:${right.semanticIdentity ?? ''}:${right.code}`, 'en'));
}

function sortPrerequisites(prerequisites: CompositionPrerequisite[]): void {
  prerequisites.sort((left, right) => `${left.capabilityId}:${left.kind}:${left.code}:${left.path ?? ''}`.localeCompare(`${right.capabilityId}:${right.kind}:${right.code}:${right.path ?? ''}`, 'en'));
}

export function composeNginxCapabilities(request: unknown): NginxCompositionOutcome {
  const emptyCapabilities: readonly {readonly definition: NginxCapabilityDefinition; readonly input: unknown}[] = [];
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return failure([diagnostic('composition.request.type', 'Composition request must be an object.', 'request')], emptyCapabilities);
  const candidate = request as Partial<NginxCompositionRequest> & Record<string, unknown>;
  const unknownRequestKey = Object.keys(candidate).filter(key => !['profile', 'target', 'capabilities'].includes(key)).sort()[0];
  if (unknownRequestKey !== undefined) return failure([diagnostic('composition.request.unknown', `Unsupported request field: ${unknownRequestKey}.`, `request.${unknownRequestKey}`)], emptyCapabilities);
  if (candidate.profile !== 'full-config' && candidate.profile !== 'site-fragment') return failure([diagnostic('composition.profile.unsupported', `Unsupported output profile: ${String(candidate.profile)}.`, 'request.profile')], emptyCapabilities);

  if (candidate.target === null || typeof candidate.target !== 'object' || Array.isArray(candidate.target)) return failure([diagnostic('composition.target.type', 'Target must be an object.', 'request.target')], emptyCapabilities);
  const target = candidate.target as Partial<NginxCompositionRequest['target']> & Record<string, unknown>;
  const unknownTargetKey = Object.keys(target).filter(key => !['version', 'modules'].includes(key)).sort()[0];
  if (unknownTargetKey !== undefined) return failure([diagnostic('composition.target.unknown', `Unsupported target field: ${unknownTargetKey}.`, `request.target.${unknownTargetKey}`)], emptyCapabilities);
  const parsedVersion = parseVersion(target.version, 'request.target.version');
  if (parsedVersion.diagnostic !== undefined || parsedVersion.value === undefined) return failure([parsedVersion.diagnostic ?? diagnostic('composition.target.version', 'Target Nginx version is invalid.', 'request.target.version')], emptyCapabilities);
  if (!Array.isArray(target.modules) || target.modules.length > 32 || target.modules.some(module => typeof module !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(module))) {
    return failure([diagnostic('composition.target.modules', 'Target modules must be a bounded array of stable module identifiers.', 'request.target.modules')], emptyCapabilities);
  }
  const targetModules = new Set(target.modules);

  if (!Array.isArray(candidate.capabilities) || candidate.capabilities.length === 0 || candidate.capabilities.length > 16) {
    return failure([diagnostic('composition.capabilities.count', 'Select between 1 and 16 capabilities.', 'request.capabilities')], emptyCapabilities);
  }

  const capabilities: {definition: NginxCapabilityDefinition; input: unknown}[] = [];
  const selectedIds = new Set<string>();
  for (let index = 0; index < candidate.capabilities.length; index += 1) {
    const selection = candidate.capabilities[index];
    const path = `request.capabilities[${index}]`;
    if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) return failure([diagnostic('composition.capability.type', 'Capability selection must be an object.', path)], capabilities);
    const selectionRecord = selection as {id?: unknown; input?: unknown} & Record<string, unknown>;
    const unknownSelectionKey = Object.keys(selectionRecord).filter(key => !['id', 'input'].includes(key)).sort()[0];
    if (unknownSelectionKey !== undefined) return failure([diagnostic('composition.capability.unknown-field', `Unsupported selection field: ${unknownSelectionKey}.`, `${path}.${unknownSelectionKey}`)], capabilities);
    if (typeof selectionRecord.id !== 'string') return failure([diagnostic('composition.capability.id', 'Capability ID must be a string.', `${path}.id`)], capabilities);
    const definition = getCapabilityDefinition(selectionRecord.id);
    if (definition === undefined) return failure([diagnostic('composition.capability.unknown', `Unsupported capability: ${selectionRecord.id}.`, `${path}.id`)], capabilities);
    if (selectedIds.has(definition.id)) return failure([diagnostic('composition.capability.duplicate', `Capability ${definition.id} was selected more than once; conflicting settings are not merged.`, path)], capabilities);
    selectedIds.add(definition.id);
    const validated = definition.validate(selectionRecord.input, `${path}.input`);
    if (!validated.ok) return failure(validated.diagnostics, capabilities);
    capabilities.push({definition, input: validated.value});
  }

  if (selectedIds.has('static-site') && selectedIds.has('reverse-proxy')) {
    const staticDomain = (capabilities.find(item => item.definition.id === 'static-site')?.input as {domain?: unknown} | undefined)?.domain;
    const proxyDomain = (capabilities.find(item => item.definition.id === 'reverse-proxy')?.input as {domain?: unknown} | undefined)?.domain;
    const conflict = staticDomain !== proxyDomain
      ? diagnostic('composition.site.domain-conflict', `Static and reverse-proxy site owners declare different domains: ${String(staticDomain)} and ${String(proxyDomain)}.`, 'request.capabilities')
      : diagnostic('composition.site.root-conflict', 'Static-site and reverse-proxy both own the root location; split them into independent sites instead of changing routing semantics implicitly.', 'request.capabilities');
    return failure([conflict], capabilities);
  }
  const hasSiteOwner = selectedIds.has('static-site') || selectedIds.has('reverse-proxy');
  const ownerDependent = capabilities.find(item => item.definition.requiresSiteOwner);
  if (!hasSiteOwner && ownerDependent !== undefined) {
    return failure([diagnostic('composition.dependency.site-owner', `${ownerDependent.definition.id} requires either reverse-proxy or static-site to establish the site.`, `request.capabilities.${ownerDependent.definition.id}`)], capabilities);
  }

  const resolution = resolveCapabilityOrder(capabilities.map(item => ({id: item.definition.id, dependencies: item.definition.dependencies})), [...selectedIds]);
  if (!resolution.ok) return failure(resolution.diagnostics, capabilities);
  for (const item of capabilities) {
    for (const incompatible of item.definition.incompatibleWith) {
      if (selectedIds.has(incompatible)) return failure([diagnostic('composition.capability.incompatible', `${item.definition.id} is incompatible with ${incompatible}.`, `request.capabilities.${item.definition.id}`)], capabilities);
    }
    const requirements = item.definition.requirements(item.input);
    if (!versionAtLeast(parsedVersion.value, requirements.minimumNginxVersion)) {
      return failure([diagnostic('composition.target.version-unsupported', `${item.definition.id} requires Nginx ${requirements.minimumNginxVersion} or newer.`, 'request.target.version')], capabilities);
    }
    const missingModule = requirements.modules.find(module => !targetModules.has(module));
    if (missingModule !== undefined) return failure([diagnostic('composition.target.module-missing', `${item.definition.id} requires the ${missingModule} module.`, 'request.target.modules')], capabilities);
  }

  const byId = new Map(capabilities.map(item => [item.definition.id, item]));
  const ordered = resolution.order.map(id => byId.get(id as NginxCapabilityId)).filter((item): item is {definition: NginxCapabilityDefinition; input: unknown} => item !== undefined);
  const contributions: CapabilityContribution[] = ordered.map(item => item.definition.contribute(item.input));
  const explanations = contributions.flatMap(item => item.explanations ?? []);
  const prerequisites = contributions.flatMap(item => item.prerequisites ?? []);
  sortExplanations(explanations);
  sortPrerequisites(prerequisites);
  const domain = contributions.map(item => item.domain).find(value => value !== undefined);
  if (domain === undefined) return failure([diagnostic('composition.site.missing', 'Composition requires exactly one trusted site owner (reverse-proxy or static-site) to establish a server and domain.', 'request.capabilities')], capabilities, explanations, prerequisites);

  const routes = contributions.flatMap(item => item.routes ?? []);
  if (routes.length > 64) return failure([diagnostic('composition.routes.expansion', 'Composition exceeds the maximum of 64 planned routes.', 'request.capabilities', 'generation')], capabilities, explanations, prerequisites, true);
  const routeKeys = new Map<string, number>();
  for (let index = 0; index < routes.length; index += 1) {
    const prefix = routes[index]?.prefix;
    if (prefix === undefined) continue;
    const first = routeKeys.get(prefix);
    if (first !== undefined) return failure([diagnostic('composition.route.duplicate', `Duplicate literal route ${prefix}; first contributed at planned route ${first}.`, `planned.routes[${index}]`, 'static')], capabilities, explanations, prerequisites, true);
    routeKeys.set(prefix, index);
  }

  const declaredUpstreams = new Set(contributions.flatMap(item => item.sharedHttpNodes ?? [])
    .filter((node): node is BlockNode<'upstream'> => node.kind === 'block' && node.blockType === 'upstream')
    .map(node => String(node.header[0]?.value)));
  const referencedUpstreams = new Set(routes.flatMap(route => route.target.kind === 'upstream' ? [route.target.nginxName] : []));
  for (const name of referencedUpstreams) {
    if (!declaredUpstreams.has(name)) return failure([diagnostic('composition.upstream.reference-missing', `Proxy target references undeclared upstream ${name}.`, 'planned.routes', 'static')], capabilities, explanations, prerequisites, true);
  }
  for (const name of declaredUpstreams) {
    if (!referencedUpstreams.has(name)) return failure([diagnostic('composition.upstream.unused', `Declared upstream ${name} is not referenced by the site reverse proxy.`, 'planned.sharedHttp', 'static')], capabilities, explanations, prerequisites, true);
  }

  const websocketPrefixes = contributions.flatMap(item => item.websocketRoutes ?? []);
  const websocketSet = new Set<string>();
  for (const prefix of websocketPrefixes) {
    if (websocketSet.has(prefix)) return failure([diagnostic('composition.websocket.duplicate', `WebSocket route ${prefix} was selected more than once.`, 'request.capabilities.websocket', 'static')], capabilities, explanations, prerequisites, true);
    if (!routeKeys.has(prefix)) return failure([diagnostic('composition.websocket.route-missing', `WebSocket support requires an existing reverse-proxy route at ${prefix}.`, 'request.capabilities.websocket', 'static')], capabilities, explanations, prerequisites, true);
    websocketSet.add(prefix);
  }

  const tls = contributions.map(item => item.tls).find(value => value !== undefined);
  const staticSite = contributions.map(item => item.staticSite).find(value => value !== undefined);
  const sharedByIdentity = new Map<string, NginxNode>();
  let sharedConflict: Diagnostic | undefined;
  for (const node of contributions.flatMap(item => item.sharedHttpNodes ?? [])) {
    const identity = semanticHttpIdentity(node);
    const existing = sharedByIdentity.get(identity);
    if (existing === undefined) sharedByIdentity.set(identity, node);
    else if (semanticNodeShape(existing) !== semanticNodeShape(node)) sharedConflict = diagnostic('composition.shared.conflict', `Shared HTTP resource ${identity} has contradictory definitions.`, 'planned.sharedHttp', 'static');
  }
  if (sharedConflict !== undefined) return failure([sharedConflict], capabilities, explanations, prerequisites, true);
  const sharedHttpNodes = [...sharedByIdentity.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([, node]) => node);
  const servers = applicationServers(domain, [...routes].sort((left, right) => left.prefix.localeCompare(right.prefix, 'en')), websocketSet, tls, undefined, staticSite);
  const engineSource: NginxSourceProvenance = {kind: 'engine', id: 'nginx-capability-composition', version: ENGINE_VERSION};

  const document = candidate.profile === 'full-config'
    ? {profile: 'full-config' as const, source: engineSource, children: [
      block('events', [], [], engineSource),
      block('http', [], [...sharedHttpNodes, ...servers], engineSource),
    ]}
    : {profile: 'site-fragment' as const, source: engineSource, children: servers};
  const primaryCompilation = serializeNginxDocument(document);
  if (!primaryCompilation.ok) return failure(primaryCompilation.diagnostics, capabilities, explanations, prerequisites, true);
  const artifacts: OutputArtifact[] = [...primaryCompilation.artifacts];
  const staticDiagnostics: Diagnostic[] = [...primaryCompilation.diagnostics];

  if (candidate.profile === 'site-fragment' && sharedHttpNodes.length > 0) {
    const supportingCompilation = serializeNginxHttpFragment(sharedHttpNodes);
    if (!supportingCompilation.ok) return failure(supportingCompilation.diagnostics, capabilities, explanations, prerequisites, true);
    const supporting = supportingCompilation.artifacts[0];
    if (supporting !== undefined) artifacts.push({...supporting, role: 'supporting'});
    staticDiagnostics.push(...supportingCompilation.diagnostics);
    const sharedCapabilityId = sharedHttpNodes[0]?.source.id as NginxCapabilityId;
    explanations.push({code: 'composition.artifact.http-shared', capabilityId: sharedCapabilityId, context: 'artifact', semanticIdentity: 'artifact:http-shared.conf', message: 'A supporting HTTP-context artifact was emitted because site fragments cannot contain HTTP-level shared resources.'});
    prerequisites.push({code: 'composition.artifact.include-http', capabilityId: sharedCapabilityId, kind: 'operator-action', description: 'Include http-shared.conf exactly once from the enclosing Nginx HTTP context.'});
  }

  for (const item of capabilities) {
    for (const module of item.definition.requirements(item.input).modules) {
      if (knownModules.has(module) && !prerequisites.some(entry => entry.kind === 'module' && entry.description.includes(module))) {
        prerequisites.push({code: `composition.module.${module}`, capabilityId: item.definition.id, kind: 'module', description: `The target Nginx build must include the ${module} module.`});
      }
    }
  }

  staticDiagnostics.push(...baseArtifactChecks(artifacts));
  if (staticDiagnostics.some(item => item.severity === 'error')) return failure(staticDiagnostics, capabilities, explanations, prerequisites, true);
  sortExplanations(explanations);
  sortPrerequisites(prerequisites);
  const validation: ValidationSummary = {
    input: {status: 'passed', diagnostics: []},
    static: {status: 'passed', diagnostics: staticDiagnostics},
    native: nativeUnavailable,
    targetHost: targetHostNotRun,
  };
  return {
    ok: true,
    artifacts,
    diagnostics: [...staticDiagnostics, ...nativeUnavailable.diagnostics],
    explanations,
    prerequisites,
    validation,
    provenance: provenance(capabilities),
  };
}
