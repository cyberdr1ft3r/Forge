import {GeneratorInputError} from './errors.js';
import type {Diagnostic, OutputArtifact} from './types.js';

type UnknownRecord = Record<string, unknown>;

export function objectInput(value: unknown): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GeneratorInputError('input.type', 'Input must be an object.');
  }
  return value as UnknownRecord;
}

export function rejectUnknownKeys(input: UnknownRecord, allowed: readonly string[]): void {
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    const path = unknown.sort()[0];
    throw new GeneratorInputError('input.unknown', `Unsupported input field: ${path}.`, path);
  }
}

function safeString(value: unknown, code: string, message: string, path?: string): string {
  if (typeof value !== 'string') throw new GeneratorInputError(code, message, path);
  return value.trim();
}

export function safeName(value: unknown, label = 'Name', path = label): string {
  const normalized = safeString(value, 'input.name', `${label} must be a string.`, path);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(normalized)) {
    throw new GeneratorInputError('input.name', `${label} must start with a letter and contain only letters, numbers, _ or - (max 63).`, path);
  }
  return normalized;
}

export function safePort(value: unknown, label = 'Port', path = label): number {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new GeneratorInputError('input.port', `${label} must be an integer between 1 and 65535.`, path);
  }
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) < 1 || Number(normalized) > 65_535) {
    throw new GeneratorInputError('input.port', `${label} must be between 1 and 65535.`, path);
  }
  return Number(normalized);
}

export function safeDomain(value: unknown): string {
  const normalized = safeString(value, 'input.domain', 'Domain must be a string.', 'domain').toLowerCase();
  const labels = normalized.split('.');
  if (normalized.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new GeneratorInputError('input.domain', 'Enter a valid fully qualified domain name.', 'domain');
  }
  return normalized;
}

export function safeBoolean(value: unknown, label: string, defaultValue: boolean, path: string): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new GeneratorInputError('input.boolean', `${label} must be a boolean (true or false).`, path);
  }
  return value;
}

export function safeAbsolutePath(value: unknown, label = 'Path', path = label): string {
  const normalized = safeString(value, 'input.path', `${label} must be a string.`, path);
  if (!/^\/[a-zA-Z0-9_./-]*$/.test(normalized) || normalized.includes('..') || normalized.includes('//')) {
    throw new GeneratorInputError('input.path', `${label} must be an absolute path without whitespace, traversal, or empty segments.`, path);
  }
  return normalized;
}

export function safeImageReference(value: unknown): string {
  const normalized = safeString(value, 'input.image', 'Image must be a string.', 'image');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\/:@-]{0,199}$/.test(normalized)) {
    throw new GeneratorInputError('input.image', 'Image must be a valid image reference without whitespace or shell characters.', 'image');
  }
  return normalized;
}

export function safeSystemdArguments(value: unknown): string {
  if (value === undefined) return '';
  const normalized = safeString(value, 'input.arguments', 'Arguments must be a string.', 'arguments');
  if (normalized.length === 0) return '';
  if (normalized.length > 500 || /[\r\n\t]/.test(normalized) || !normalized.split(/ +/).every(token => /^[a-zA-Z0-9._\/:=@+-]+$/.test(token))) {
    throw new GeneratorInputError('input.arguments', 'Arguments must be space-separated literal values without quoting, shell operators, control characters, or systemd specifiers; edit manually after review.', 'arguments');
  }
  return normalized;
}

export function baseArtifactChecks(artifacts: readonly OutputArtifact[]): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ids = new Set<string>();
  const filenames = new Set<string>();
  if (artifacts.length === 0) diagnostics.push({code: 'artifact.none', severity: 'error', stage: 'static', message: 'The generator produced no artifacts.'});
  if (artifacts.filter(artifact => artifact.role === 'primary').length !== 1) {
    diagnostics.push({code: 'artifact.primary', severity: 'error', stage: 'static', message: 'The generator must produce exactly one primary artifact.'});
  }
  for (const artifact of artifacts) {
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(artifact.id)) {
      diagnostics.push({code: 'artifact.id', severity: 'error', stage: 'static', message: `Unsafe artifact ID: ${artifact.id}.`});
    }
    if (ids.has(artifact.id)) diagnostics.push({code: 'artifact.id-duplicate', severity: 'error', stage: 'static', message: `Duplicate artifact ID: ${artifact.id}.`});
    ids.add(artifact.id);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(artifact.filename)) {
      diagnostics.push({code: 'artifact.filename', severity: 'error', stage: 'static', message: `Unsafe artifact filename: ${artifact.filename}.`});
    }
    if (filenames.has(artifact.filename)) diagnostics.push({code: 'artifact.duplicate', severity: 'error', stage: 'static', message: `Duplicate artifact filename: ${artifact.filename}.`});
    filenames.add(artifact.filename);
    if (artifact.content.includes('\0') || artifact.content.includes('\r')) diagnostics.push({code: 'artifact.control-character', severity: 'error', stage: 'static', message: `${artifact.filename} contains unsupported control characters.`});
    if (!artifact.content.endsWith('\n')) diagnostics.push({code: 'artifact.trailing-newline', severity: 'error', stage: 'static', message: `${artifact.filename} must end with a newline.`});
  }
  return diagnostics;
}
