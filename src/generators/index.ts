import {generate, toLegacyResult, tryGenerate} from '../core/lifecycle.js';
import {GeneratorRegistry} from '../core/registry.js';
import type {LegacyGeneratorResult} from '../core/types.js';
import {composeGenerator} from './compose.js';
import {nginxGenerator} from './nginx.js';
import {systemdGenerator} from './systemd.js';

export * from '../core/errors.js';
export * from '../core/lifecycle.js';
export * from '../core/types.js';
export {composeGenerator, nginxGenerator, systemdGenerator};

export const generatorRegistry = new GeneratorRegistry();
generatorRegistry.register(nginxGenerator);
generatorRegistry.register(composeGenerator);
generatorRegistry.register(systemdGenerator);

export const generateNginx = (input: unknown): LegacyGeneratorResult => toLegacyResult(generate(nginxGenerator, input));
export const generateCompose = (input: unknown): LegacyGeneratorResult => toLegacyResult(generate(composeGenerator, input));
export const generateSystemd = (input: unknown): LegacyGeneratorResult => toLegacyResult(generate(systemdGenerator, input));

export const generators = {
  nginx: generateNginx,
  compose: generateCompose,
  systemd: generateSystemd,
} as const;

export const outcomes = {
  nginx: (input: unknown) => tryGenerate(nginxGenerator, input),
  compose: (input: unknown) => tryGenerate(composeGenerator, input),
  systemd: (input: unknown) => tryGenerate(systemdGenerator, input),
} as const;
