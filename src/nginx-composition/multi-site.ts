import {baseArtifactChecks} from '../core/validation.js';
import type {Diagnostic, OutputArtifact, ValidationRecord, ValidationSummary} from '../core/types.js';
import {serializeNginxDocument, serializeNginxHttpFragment} from '../nginx-syntax/serializer.js';
import {block} from '../nginx-syntax/types.js';
import type {NginxNode, NginxSourceProvenance} from '../nginx-syntax/types.js';
import {getCapabilityDefinition} from './capabilities.js';
import {applicationServers, composeNginxCapabilities} from './planner.js';
import type {
  CapabilityContribution,
  CompositionExplanation,
  CompositionPrerequisite,
  NginxCapabilityDefinition,
  NginxCapabilityId,
  NginxCompositionOutcome,
  NginxMultiSiteCompositionRequest,
  PlannedRoute,
} from './types.js';

const ENGINE_VERSION = '2.4.0' as const;
const MAX_SITES = 16;
const MAX_TOTAL_ROUTES = 256;
const SITE_ID = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type ValidatedCapability = {readonly definition: NginxCapabilityDefinition; readonly input: unknown};

interface SitePlan {
  readonly id: string;
  readonly capabilities: readonly ValidatedCapability[];
  readonly contributions: readonly CapabilityContribution[];
  readonly servers: readonly NginxNode[];
  readonly shared: readonly SharedHttpResourceInput[];
  readonly explanations: readonly CompositionExplanation[];
  readonly prerequisites: readonly CompositionPrerequisite[];
  readonly listeners: readonly {readonly port: 80 | 443; readonly mode: 'http' | 'https'; readonly serverName: string}[];
  readonly routeCount: number;
}

export interface SharedHttpResourceInput {
  readonly node: NginxNode;
  readonly siteId: string;
}

export interface MergedSharedHttpResource {
  readonly identity: string;
  readonly node: NginxNode;
  readonly siteIds: readonly string[];
}

export type SharedHttpMergeResult =
  | {readonly ok: true; readonly resources: readonly MergedSharedHttpResource[]; readonly diagnostics: readonly []}
  | {readonly ok: false; readonly resources: readonly []; readonly diagnostics: readonly Diagnostic[]};

const nativeUnavailable: ValidationRecord = {
  status: 'unavailable',
  validator: 'nginx -t',
  diagnostics: [{code: 'native.unavailable', severity: 'warning', stage: 'native', message: 'Forge structural validation passed; an Nginx parser did not run.'}],
};
const targetHostNotRun: ValidationRecord = {
  status: 'not-run',
  validator: 'target-host nginx readiness',
  diagnostics: [{code: 'target-host.not-run', severity: 'warning', stage: 'target-host', message: 'The target host, installed modules, certificates, filesystem, permissions, and external services were not inspected.'}],
};
const notRun: ValidationRecord = {status: 'not-run', diagnostics: []};

function error(code: string, message: string, path: string, stage: 'input' | 'static' | 'generation' = 'input', siteId?: string): Diagnostic {
  const common = {code, message, path, severity: 'error' as const, stage};
  return siteId === undefined ? common : {...common, siteId};
}

function allCapabilities(plans: readonly SitePlan[]): readonly ValidatedCapability[] {
  const unique = new Map<NginxCapabilityId, ValidatedCapability>();
  for (const plan of plans) for (const capability of plan.capabilities) unique.set(capability.definition.id, capability);
  return [...unique.values()].sort((left, right) => left.definition.id.localeCompare(right.definition.id, 'en'));
}

function provenance(plans: readonly SitePlan[]) {
  return {
    generatedBy: 'Forge' as const,
    engine: 'nginx-capability-composition' as const,
    version: ENGINE_VERSION,
    deterministic: true as const,
    capabilities: allCapabilities(plans).map(item => ({id: item.definition.id, version: item.definition.version})),
    sites: plans.map(plan => plan.id).sort((left, right) => left.localeCompare(right, 'en')),
  };
}

function failure(diagnostics: readonly Diagnostic[], plans: readonly SitePlan[] = [], explanations: readonly CompositionExplanation[] = [], prerequisites: readonly CompositionPrerequisite[] = [], inputPassed = false): NginxCompositionOutcome {
  const inputDiagnostics = diagnostics.filter(item => item.stage === 'input');
  const staticDiagnostics = diagnostics.filter(item => item.stage === 'static');
  const validation: ValidationSummary = {
    input: inputPassed ? {status: 'passed', diagnostics: []} : {status: 'failed', diagnostics: inputDiagnostics},
    static: staticDiagnostics.length > 0 ? {status: 'failed', diagnostics: staticDiagnostics} : notRun,
    native: nativeUnavailable,
    targetHost: targetHostNotRun,
  };
  return {ok: false, artifacts: [], diagnostics: [...diagnostics, ...nativeUnavailable.diagnostics], explanations, prerequisites, validation, provenance: provenance(plans)};
}

function scopeSource(source: NginxSourceProvenance, siteId: string): NginxSourceProvenance {
  return {...source, siteId};
}

function scopeNode(node: NginxNode, siteId: string): NginxNode {
  if (node.kind === 'directive') return {...node, source: scopeSource(node.source, siteId)};
  if (node.kind === 'map-entry') return {...node, source: scopeSource(node.source, siteId)};
  return {...node, source: scopeSource(node.source, siteId), children: node.children.map(child => scopeNode(child, siteId))};
}

function semanticIdentity(node: NginxNode): string {
  if (node.kind === 'block' && node.blockType === 'map') return `map:${String(node.header[1]?.value)}`;
  if (node.kind === 'block' && node.blockType === 'upstream') return `upstream:${String(node.header[0]?.value)}`;
  if (node.kind === 'directive' && node.name === 'log_format') return `log-format:${String(node.args[0]?.value)}`;
  if (node.kind === 'directive' && (node.name === 'limit_req_zone' || node.name === 'limit_conn_zone')) {
    const definition = String(node.args[1]?.value);
    const zoneName = /^zone=([^:]+):/.exec(definition)?.[1] ?? definition;
    return `${node.name}:${zoneName}`;
  }
  return `${node.kind}:${node.kind === 'directive' ? node.name : node.kind === 'block' ? node.blockType : String(node.key.value)}`;
}

function semanticShape(node: NginxNode): string {
  return JSON.stringify(node, (key, value: unknown) => key === 'source' ? undefined : value);
}

/** Merge by trusted semantic identity, not rendered text. Contradictory identities fail closed. */
export function mergeSharedHttpResources(inputs: readonly SharedHttpResourceInput[]): SharedHttpMergeResult {
  const merged = new Map<string, {node: NginxNode; siteIds: Set<string>} >();
  for (const input of [...inputs].sort((left, right) => left.siteId.localeCompare(right.siteId, 'en'))) {
    const identity = semanticIdentity(input.node);
    const existing = merged.get(identity);
    if (existing === undefined) {
      merged.set(identity, {node: input.node, siteIds: new Set([input.siteId])});
      continue;
    }
    if (semanticShape(existing.node) !== semanticShape(input.node)) {
      const sites = [...existing.siteIds, input.siteId].sort((left, right) => left.localeCompare(right, 'en'));
      return {ok: false, resources: [], diagnostics: [error('composition.shared.conflict', `Shared HTTP resource ${identity} has contradictory definitions for sites ${sites.join(', ')}.`, 'planned.sharedHttp', 'static', input.siteId)]};
    }
    existing.siteIds.add(input.siteId);
  }
  return {
    ok: true,
    diagnostics: [],
    resources: [...merged.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([identity, value]) => ({identity, node: value.node, siteIds: [...value.siteIds].sort((left, right) => left.localeCompare(right, 'en'))})),
  };
}

function scopedDiagnostic(item: Diagnostic, siteId: string, sitePath: string): Diagnostic {
  if (!item.path?.startsWith('request.capabilities')) return item;
  return {...item, path: item.path.replace(/^request\.capabilities/, `${sitePath}.capabilities`), siteId};
}

function planSite(id: string, capabilitiesInput: readonly unknown[], request: NginxMultiSiteCompositionRequest, sitePath: string): SitePlan | readonly Diagnostic[] {
  const legacy = composeNginxCapabilities({profile: request.profile, target: request.target, capabilities: capabilitiesInput});
  if (!legacy.ok) return legacy.diagnostics.filter(item => item.severity === 'error').map(item => scopedDiagnostic(item, id, sitePath));

  const capabilities: ValidatedCapability[] = [];
  for (let index = 0; index < capabilitiesInput.length; index += 1) {
    const selection = capabilitiesInput[index] as {readonly id: string; readonly input: unknown};
    const definition = getCapabilityDefinition(selection.id);
    if (definition === undefined) return [error('composition.capability.unknown', `Unsupported capability: ${selection.id}.`, `${sitePath}.capabilities[${index}].id`, 'input', id)];
    const validated = definition.validate(selection.input, `${sitePath}.capabilities[${index}].input`);
    if (!validated.ok) return validated.diagnostics.map(item => ({...item, siteId: id}));
    capabilities.push({definition, input: validated.value});
  }
  capabilities.sort((left, right) => left.definition.id.localeCompare(right.definition.id, 'en'));
  const contributions = capabilities.map(item => item.definition.contribute(item.input));
  const domain = contributions.map(item => item.domain).find(value => value !== undefined);
  if (domain === undefined) return [error('composition.site.missing', 'Site requires reverse-proxy to establish an exact server name.', `${sitePath}.capabilities`, 'input', id)];
  const routes = contributions.flatMap(item => item.routes ?? []).map(route => ({...route, source: scopeSource(route.source, id)}));
  const websocketRoutes = new Set(contributions.flatMap(item => item.websocketRoutes ?? []));
  const tls = contributions.map(item => item.tls).find(value => value !== undefined);
  const scopedTls = tls === undefined ? undefined : {...tls, source: scopeSource(tls.source, id), directives: tls.directives.map(node => ({...node, source: scopeSource(node.source, id)}))};
  const staticSite = contributions.map(item => item.staticSite).find(value => value !== undefined);
  const scopedStaticSite = staticSite === undefined ? undefined : {
    ...staticSite,
    source: scopeSource(staticSite.source, id),
    serverDirectives: staticSite.serverDirectives.map(node => ({...node, source: scopeSource(node.source, id)})),
    rootLocation: scopeNode(staticSite.rootLocation, id),
  };
  const logging = contributions.map(item => item.logging).find(value => value !== undefined);
  const scopedLogging = logging === undefined ? undefined : {
    ...logging,
    source: scopeSource(logging.source, id),
    directives: logging.directives.map(node => ({...node, source: scopeSource(node.source, id)})),
  };
  const trafficLimiting = contributions.map(item => item.trafficLimiting).find(value => value !== undefined);
  const scopedTrafficLimiting = trafficLimiting === undefined ? undefined : {
    ...trafficLimiting,
    source: scopeSource(trafficLimiting.source, id),
    directives: trafficLimiting.directives.map(node => ({...node, source: scopeSource(node.source, id)})),
  };
  const servers = applicationServers(domain, [...routes].sort((left, right) => left.prefix.localeCompare(right.prefix, 'en')), websocketRoutes, scopedTls, id, scopedStaticSite, scopedLogging, scopedTrafficLimiting);
  const explanations = contributions.flatMap(item => item.explanations ?? []).map(item => ({...item, siteId: id}));
  const prerequisites = contributions.flatMap(item => item.prerequisites ?? []).map(item => ({...item, siteId: id}));
  const shared = contributions.flatMap(item => item.sharedHttpNodes ?? []).map(node => ({node: scopeNode(node, id), siteId: id}));
  const listeners = tls === undefined
    ? [{port: 80 as const, mode: 'http' as const, serverName: domain}]
    : [
      {port: 443 as const, mode: 'https' as const, serverName: domain},
      ...(tls.redirectHttp ? [{port: 80 as const, mode: 'http' as const, serverName: domain}] : []),
    ];
  return {id, capabilities, contributions, servers, shared, explanations, prerequisites, listeners, routeCount: routes.length};
}

function isDiagnostics(value: SitePlan | readonly Diagnostic[]): value is readonly Diagnostic[] {
  return Array.isArray(value);
}

function sortMetadata(explanations: CompositionExplanation[], prerequisites: CompositionPrerequisite[]): void {
  explanations.sort((left, right) => `${left.siteId ?? ''}:${left.capabilityId}:${left.context}:${left.semanticIdentity ?? ''}:${left.code}`.localeCompare(`${right.siteId ?? ''}:${right.capabilityId}:${right.context}:${right.semanticIdentity ?? ''}:${right.code}`, 'en'));
  prerequisites.sort((left, right) => `${left.siteId ?? ''}:${left.capabilityId}:${left.kind}:${left.code}:${left.path ?? ''}`.localeCompare(`${right.siteId ?? ''}:${right.capabilityId}:${right.kind}:${right.code}:${right.path ?? ''}`, 'en'));
}

export function composeNginxSites(request: unknown): NginxCompositionOutcome {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return failure([error('composition.request.type', 'Multi-site composition request must be an object.', 'request')]);
  const candidate = request as Partial<NginxMultiSiteCompositionRequest> & Record<string, unknown>;
  const unknownKey = Object.keys(candidate).filter(key => !['profile', 'target', 'sites'].includes(key)).sort()[0];
  if (unknownKey !== undefined) return failure([error('composition.request.unknown', `Unsupported request field: ${unknownKey}.`, `request.${unknownKey}`)]);
  if (candidate.profile !== 'full-config' && candidate.profile !== 'site-fragment') return failure([error('composition.profile.unsupported', `Unsupported output profile: ${String(candidate.profile)}.`, 'request.profile')]);
  if (!Array.isArray(candidate.sites) || candidate.sites.length === 0 || candidate.sites.length > MAX_SITES) return failure([error('composition.sites.count', `Provide between 1 and ${MAX_SITES} sites.`, 'request.sites')]);

  const rawSites: {id: string; capabilities: readonly unknown[]; path: string}[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < candidate.sites.length; index += 1) {
    const path = `request.sites[${index}]`;
    const value = candidate.sites[index];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return failure([error('composition.site.type', 'Site definition must be an object.', path)]);
    const site = value as {id?: unknown; capabilities?: unknown} & Record<string, unknown>;
    const unknownSiteKey = Object.keys(site).filter(key => !['id', 'capabilities'].includes(key)).sort()[0];
    if (unknownSiteKey !== undefined) return failure([error('composition.site.unknown', `Unsupported site field: ${unknownSiteKey}.`, `${path}.${unknownSiteKey}`)]);
    if (typeof site.id !== 'string' || !SITE_ID.test(site.id)) return failure([error('composition.site.id', 'Site ID must be a stable lowercase identifier (1-63 letters, digits, or internal hyphens).', `${path}.id`)]);
    if (ids.has(site.id)) return failure([error('composition.site.duplicate', `Site ID ${site.id} is duplicated.`, `${path}.id`, 'input', site.id)]);
    ids.add(site.id);
    if (!Array.isArray(site.capabilities)) return failure([error('composition.capabilities.count', 'Site capabilities must be an array.', `${path}.capabilities`, 'input', site.id)]);
    rawSites.push({id: site.id, capabilities: site.capabilities, path});
  }

  const typedRequest = candidate as NginxMultiSiteCompositionRequest;
  const plans: SitePlan[] = [];
  for (const raw of rawSites.sort((left, right) => left.id.localeCompare(right.id, 'en'))) {
    const planned = planSite(raw.id, raw.capabilities, typedRequest, raw.path);
    if (isDiagnostics(planned)) return failure(planned, plans);
    plans.push(planned);
  }
  const totalRoutes = plans.reduce((total, plan) => total + plan.routeCount, 0);
  if (totalRoutes > MAX_TOTAL_ROUTES) return failure([error('composition.routes.expansion', `Multi-site composition exceeds the maximum of ${MAX_TOTAL_ROUTES} planned routes.`, 'planned.routes', 'generation')], plans, [], [], true);

  const listenerOwners = new Map<string, {siteId: string; mode: 'http' | 'https'}>();
  for (const plan of plans) for (const listener of plan.listeners) {
    const identity = `${listener.port}:${listener.serverName}`;
    const existing = listenerOwners.get(identity);
    if (existing !== undefined) return failure([error('composition.server.conflict', `Site ${plan.id} conflicts with site ${existing.siteId}: exact server name ${listener.serverName} is already assigned to listener ${listener.port}.`, `planned.sites.${plan.id}.listeners`, 'static', plan.id)], plans, [], [], true);
    listenerOwners.set(identity, {siteId: plan.id, mode: listener.mode});
  }

  const merged = mergeSharedHttpResources(plans.flatMap(plan => plan.shared));
  const explanations = plans.flatMap(plan => plan.explanations);
  const prerequisites = plans.flatMap(plan => plan.prerequisites);
  if (!merged.ok) return failure(merged.diagnostics, plans, explanations, prerequisites, true);
  const trafficZoneMemoryMb = merged.resources.reduce((total, resource) => {
    if (resource.node.kind !== 'directive' || (resource.node.name !== 'limit_req_zone' && resource.node.name !== 'limit_conn_zone')) return total;
    return total + Number(/:(\d+)m$/.exec(String(resource.node.args[1]?.value))?.[1] ?? 0);
  }, 0);
  if (trafficZoneMemoryMb > 256) {
    return failure([error('composition.traffic-limiting.memory-budget', 'Distinct traffic-limiting zones exceed the 256 MiB multi-site shared-memory budget.', 'planned.sharedHttp', 'static')], plans, explanations, prerequisites, true);
  }
  for (const resource of merged.resources) {
    const representative = explanations.find(item => item.semanticIdentity === resource.identity && (item.context === 'http' || item.context === 'upstream'));
    if (representative !== undefined && resource.siteIds.length > 1) {
      const {siteId: _siteId, ...sharedExplanation} = representative;
      explanations.push({...sharedExplanation, code: 'composition.shared.dependencies', siteIds: resource.siteIds, message: `Shared HTTP resource ${resource.identity} is emitted once for sites ${resource.siteIds.join(', ')}.`});
    }
  }

  const sharedNodes = merged.resources.map(resource => resource.node);
  const servers = plans.flatMap(plan => plan.servers);
  const engineSource: NginxSourceProvenance = {kind: 'engine', id: 'nginx-capability-composition', version: ENGINE_VERSION};
  const document = candidate.profile === 'full-config'
    ? {profile: 'full-config' as const, source: engineSource, children: [block('events', [], [], engineSource), block('http', [], [...sharedNodes, ...servers], engineSource)]}
    : {profile: 'site-fragment' as const, source: engineSource, children: servers};
  const primary = serializeNginxDocument(document);
  if (!primary.ok) return failure(primary.diagnostics, plans, explanations, prerequisites, true);
  const artifacts: OutputArtifact[] = [...primary.artifacts];
  const staticDiagnostics: Diagnostic[] = [...primary.diagnostics];
  if (candidate.profile === 'site-fragment' && sharedNodes.length > 0) {
    const supporting = serializeNginxHttpFragment(sharedNodes);
    if (!supporting.ok) return failure(supporting.diagnostics, plans, explanations, prerequisites, true);
    const artifact = supporting.artifacts[0];
    if (artifact !== undefined) artifacts.push({...artifact, role: 'supporting'});
    const sharedCapabilityId = sharedNodes[0]?.source.id as NginxCapabilityId;
    explanations.push({code: 'composition.artifact.http-shared', capabilityId: sharedCapabilityId, context: 'artifact', semanticIdentity: 'artifact:http-shared.conf', siteIds: merged.resources.flatMap(item => item.siteIds).filter((id, index, all) => all.indexOf(id) === index).sort(), message: 'One supporting HTTP-context artifact contains shared resources for all dependent sites.'});
    prerequisites.push({code: 'composition.artifact.include-http', capabilityId: sharedCapabilityId, kind: 'operator-action', description: 'Include http-shared.conf exactly once from the enclosing Nginx HTTP context before site.conf.'});
  }
  staticDiagnostics.push(...baseArtifactChecks(artifacts));
  if (staticDiagnostics.some(item => item.severity === 'error')) return failure(staticDiagnostics, plans, explanations, prerequisites, true);
  sortMetadata(explanations, prerequisites);
  const validation: ValidationSummary = {input: {status: 'passed', diagnostics: []}, static: {status: 'passed', diagnostics: staticDiagnostics}, native: nativeUnavailable, targetHost: targetHostNotRun};
  return {ok: true, artifacts, diagnostics: [...staticDiagnostics, ...nativeUnavailable.diagnostics], explanations, prerequisites, validation, provenance: provenance(plans)};
}
