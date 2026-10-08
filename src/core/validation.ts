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
    throw new GeneratorInputError('input.unknown', `Unsupported input field: ${unknown.sort()[0]}.`);
  }
}

export function safeName(value: unknown, label = 'Name'): string {
  const normalized = String(value ?? '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(normalized)) {
    throw new GeneratorInputError('input.name', `${label} must start with a letter and contain only letters, numbers, _ or - (max 63).`);
  }
  return normalized;
}

export function safePort(value: unknown, label = 'Port'): number {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) < 1 || Number(normalized) > 65_535) {
    throw new GeneratorInputError('input.port', `${label} must be between 1 and 65535.`);
  }
  return Number(normalized);
}

export function safeDomain(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  const labels = normalized.split('.');
  if (normalized.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new GeneratorInputError('input.domain', 'Enter a valid fully qualified domain name.');
  }
  return normalized;
}

export function safeBoolean(value: unknown): boolean {
  return value === true;
}

export function safeAbsolutePath(value: unknown, label = 'Path'): string {
  const normalized = String(value ?? '').trim();
  if (!/^\/[a-zA-Z0-9_./-]*$/.test(normalized) || normalized.includes('..') || normalized.includes('//')) {
    throw new GeneratorInputError('input.path', `${label} must be an absolute path without whitespace, traversal, or empty segments.`);
  }
  return normalized;
}

export function safeImageReference(value: unknown): string {
  const normalized = String(value ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\/:@-]{0,199}$/.test(normalized)) {
    throw new GeneratorInputError('input.image', 'Image must be a valid image reference without whitespace or shell characters.');
  }
  return normalized;
}

export function safeSystemdArguments(value: unknown): string {
  const normalized = String(value ?? '').trim();
  if (normalized.length === 0) return '';
  if (normalized.length > 500 || /[\r\n\t]/.test(normalized) || !normalized.split(/ +/).every(token => /^[a-zA-Z0-9._\/:=@+-]+$/.test(token))) {
    throw new GeneratorInputError('input.arguments', 'Arguments must be space-separated literal values without quoting, shell operators, control characters, or systemd specifiers; edit manually after review.');
  }
  return normalized;
}

export function baseArtifactChecks(artifacts: readonly OutputArtifact[]): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const filenames = new Set<string>();
  if (artifacts.length === 0) diagnostics.push({code: 'artifact.none', severity: 'error', stage: 'static', message: 'The generator produced no artifacts.'});
  for (const artifact of artifacts) {
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
