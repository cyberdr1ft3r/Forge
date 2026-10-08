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

function validEndpoint(value: string): boolean {
  if (value.length > 512 || /[\s\0\r\n{};"'\\]/.test(value)) return false;
  const match = /^(?:https?:\/\/)?(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(?:\/[A-Za-z0-9._~!&()*+,=:@%/-]*)?$/.exec(value);
  if (match === null) return false;
  const host = match[1];
  const port = match[2];
  if (host === undefined) return false;
  const validHost = host.startsWith('[')
    ? /^\[[0-9A-Fa-f:]+\]$/.test(host)
    : host === 'localhost' || (host.length <= 253 && host.split('.').every(label => domainLabel.test(label.toLowerCase())));
  return validHost && (port === undefined || (Number(port) >= 1 && Number(port) <= 65_535));
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
    case 'endpoint':
      return validEndpoint(value) ? undefined : 'Endpoint must be a bounded HTTP endpoint or host with an optional valid port and safe path.';
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
