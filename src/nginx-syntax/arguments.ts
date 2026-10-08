import type {ArgumentRule} from './registry.js';
import type {KnownNginxVariable, NginxArgument} from './types.js';

const allowedVariables = new Set<KnownNginxVariable>([
  '$connection_upgrade',
  '$host',
  '$http_upgrade',
  '$proxy_add_x_forwarded_for',
  '$remote_addr',
  '$request_uri',
  '$scheme',
]);

const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validDomain(value: string): boolean {
  const normalized = value.toLowerCase();
  const labels = normalized.split('.');
  return normalized.length <= 253 && labels.length >= 2 && labels.every(label => domainLabel.test(label));
}

function validPath(value: string): boolean {
  return value.length <= 512
    && /^\/[A-Za-z0-9_.*?/-]*$/.test(value)
    && !value.includes('//')
    && !value.split('/').includes('..');
}

function validHost(host: string): boolean {
  if (host.startsWith('[')) {
    const address = host.slice(1, -1);
    return host.endsWith(']')
      && address.includes(':')
      && !address.includes(':::')
      && /^[0-9A-Fa-f:]+$/.test(address);
  }
  return host === 'localhost'
    || (host.length <= 253 && host.split('.').every(label => domainLabel.test(label.toLowerCase())));
}

function validPort(port: string | undefined): boolean {
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
}

function validProxyUrl(value: string): boolean {
  if (value.length > 512 || /[\s\0\r\n{};"'\\$]/.test(value)) return false;
  const match = /^https?:\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(?:\/[A-Za-z0-9._~!&()*+,=:@%/-]*)?$/.exec(value);
  if (match === null) return false;
  const host = match[1];
  const port = match[2];
  if (host === undefined) return false;
  return validHost(host) && validPort(port);
}

function validUpstreamAddress(value: string): boolean {
  if (value.length > 263 || /[\s\0\r\n{};"'\\/$]/.test(value)) return false;
  const match = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  if (match === null || match[1] === undefined) return false;
  return validHost(match[1]) && validPort(match[2]);
}

function validLocationPrefix(value: string): boolean {
  return value.length <= 512
    && /^\/[A-Za-z0-9._~!&()+,=:@%/-]*$/.test(value)
    && !value.includes('//')
    && !value.split('/').includes('..');
}

export function validateArgument(argument: unknown, rule: ArgumentRule): string | undefined {
  if (argument === null || typeof argument !== 'object' || Array.isArray(argument)) return 'Argument must be a typed Nginx argument.';
  const candidate = argument as Partial<NginxArgument>;
  if (typeof candidate.kind !== 'string' || !rule.kinds.includes(candidate.kind)) return `Argument kind must be one of: ${rule.kinds.join(', ')}.`;

  if (candidate.kind === 'integer') {
    if (typeof candidate.value !== 'number' || !Number.isSafeInteger(candidate.value)) return 'Integer argument must be a safe integer.';
    if (rule.minimum !== undefined && candidate.value < rule.minimum) return `Integer argument must be at least ${rule.minimum}.`;
    if (rule.maximum !== undefined && candidate.value > rule.maximum) return `Integer argument must be at most ${rule.maximum}.`;
    return undefined;
  }

  if (typeof candidate.value !== 'string') return 'Argument value must be a string.';
  const value = candidate.value;
  if (value.length === 0) return 'Argument value must not be empty.';

  switch (candidate.kind) {
    case 'variable':
      return allowedVariables.has(value as KnownNginxVariable) ? undefined : 'Variable is not in the trusted Nginx variable allowlist.';
    case 'keyword':
      return rule.keywords?.includes(value) === true ? undefined : `Keyword must be one of: ${rule.keywords?.join(', ') ?? '(none)'}.`;
    case 'identifier':
      return /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(value) ? undefined : 'Identifier contains unsupported characters or is too long.';
    case 'domain':
      return validDomain(value) ? undefined : 'Domain must be a fully qualified DNS name.';
    case 'path':
      return validPath(value) ? undefined : 'Path must be absolute, bounded, traversal-free, and contain only safe path or glob characters.';
    case 'proxy-url':
      return validProxyUrl(value) ? undefined : 'Proxy URL must be a literal http:// or https:// URL with a valid host, optional port, and safe path.';
    case 'upstream-address':
      return validUpstreamAddress(value) ? undefined : 'Upstream address must be a host or bracketed IPv6 address with an optional valid port, without a scheme or path.';
    case 'location-prefix':
      return validLocationPrefix(value) ? undefined : 'Location prefix must be a literal absolute URI path without globs, regex modifiers, variables, traversal, or query syntax.';
    case 'header-name':
      return /^[A-Za-z][A-Za-z0-9-]{0,126}$/.test(value) ? undefined : 'Header name contains unsupported characters or is too long.';
    case 'quoted':
      return value.length <= 1024 && !/[\0\r\n\t]/.test(value) ? undefined : 'Quoted value contains a control character or exceeds 1024 characters.';
    case 'literal':
      return value.length <= 512 && /^[A-Za-z0-9._~:/+-]+$/.test(value) ? undefined : 'Literal contains whitespace, syntax delimiters, variable markers, or unsupported characters.';
  }
}

export function serializeArgument(argument: NginxArgument): string {
  if (argument.kind === 'integer') return String(argument.value);
  if (argument.kind === 'quoted') {
    const escaped = argument.value
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('$', '\\$');
    return `"${escaped}"`;
  }
  return argument.value;
}

export function argumentIdentity(argument: unknown): string {
  if (argument === null || typeof argument !== 'object') return 'invalid';
  const candidate = argument as {kind?: unknown; value?: unknown};
  return `${String(candidate.kind)}:${String(candidate.value)}`;
}
