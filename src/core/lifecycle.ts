import {GeneratorExecutionError, GeneratorInputError} from './errors.js';
import {baseArtifactChecks} from './validation.js';
import {GENERATOR_CONTRACT_VERSION} from './types.js';
import type {Diagnostic, GenerationFailure, GenerationOutcome, GenerationResult, GeneratorDefinition, GeneratorProvenance, LegacyGeneratorResult, ValidationRecord} from './types.js';

const notRun: ValidationRecord = {status: 'not-run', diagnostics: []};

function provenance<TInput, TNormalized>(definition: GeneratorDefinition<TInput, TNormalized>): GeneratorProvenance {
  return {
    generatedBy: 'Forge',
    contractVersion: GENERATOR_CONTRACT_VERSION,
    generatorId: definition.manifest.id,
    generatorVersion: definition.manifest.generatorVersion,
    deterministic: true,
  };
}

function nativeUnavailable<TInput, TNormalized>(definition: GeneratorDefinition<TInput, TNormalized>): ValidationRecord {
  const capability = definition.manifest.nativeValidation;
  return {
    status: 'unavailable',
    validator: capability.tool,
    diagnostics: [{code: 'native.unavailable', severity: 'warning', stage: 'native', message: capability.reason}],
  };
}

export function tryGenerate<TInput, TNormalized>(definition: GeneratorDefinition<TInput, TNormalized>, rawInput: unknown): GenerationOutcome {
  const shared = {
    compatibility: definition.manifest.compatibility,
    provenance: provenance(definition),
  };
  let input: TInput;
  try {
    input = definition.validate(rawInput);
  } catch (error) {
    const known = error instanceof GeneratorInputError;
    const diagnostic: Diagnostic = {
      code: known ? error.code : 'input.unexpected',
      severity: 'error',
      stage: 'input',
      message: known ? error.message : 'Input validation failed unexpectedly.',
      ...(known && error.path !== undefined ? {path: error.path} : {}),
    };
    return {
      ok: false,
      artifacts: [],
      diagnostics: [diagnostic],
      warnings: [],
      deploymentSteps: [],
      validation: {input: {status: 'failed', diagnostics: [diagnostic]}, static: notRun, native: nativeUnavailable(definition)},
      ...shared,
    } satisfies GenerationFailure;
  }

  let draft;
  try {
    draft = definition.generate(definition.normalize(input));
  } catch {
    const diagnostic: Diagnostic = {code: 'generation.failed', severity: 'error', stage: 'generation', message: 'Configuration generation failed unexpectedly.'};
    return {
      ok: false,
      artifacts: [],
      diagnostics: [diagnostic],
      warnings: [],
      deploymentSteps: [],
      validation: {input: {status: 'passed', diagnostics: []}, static: notRun, native: nativeUnavailable(definition)},
      ...shared,
    } satisfies GenerationFailure;
  }

  const staticDiagnostics = [...baseArtifactChecks(draft.artifacts), ...definition.staticValidate(draft.artifacts)];
  const native = nativeUnavailable(definition);
  const diagnostics = [...draft.diagnostics, ...staticDiagnostics, ...native.diagnostics];
  if (staticDiagnostics.some(item => item.severity === 'error')) {
    return {
      ok: false,
      artifacts: [],
      diagnostics,
      warnings: diagnostics.filter(item => item.severity === 'warning'),
      deploymentSteps: [],
      validation: {input: {status: 'passed', diagnostics: []}, static: {status: 'failed', diagnostics: staticDiagnostics}, native},
      ...shared,
    } satisfies GenerationFailure;
  }
  return {
    ok: true,
    artifacts: draft.artifacts,
    diagnostics,
    warnings: diagnostics.filter(item => item.severity === 'warning'),
    deploymentSteps: draft.deploymentSteps,
    validation: {input: {status: 'passed', diagnostics: []}, static: {status: 'passed', diagnostics: staticDiagnostics}, native},
    ...shared,
  } satisfies GenerationResult;
}

export function generate<TInput, TNormalized>(definition: GeneratorDefinition<TInput, TNormalized>, rawInput: unknown): GenerationResult {
  const outcome = tryGenerate(definition, rawInput);
  if (!outcome.ok) {
    const diagnostic = outcome.diagnostics.find(item => item.severity === 'error');
    throw new GeneratorExecutionError(diagnostic?.code ?? 'generation.failed', diagnostic?.message ?? 'Configuration generation failed.');
  }
  return outcome;
}

export function toLegacyResult(result: GenerationResult): LegacyGeneratorResult {
  const primary = result.artifacts.find(artifact => artifact.role === 'primary');
  if (primary === undefined) throw new GeneratorExecutionError('export.primary-missing', 'The generator produced no primary artifact.');
  return {
    filename: primary.filename,
    content: primary.content,
    steps: result.deploymentSteps,
    checks: result.warnings.map(item => item.message),
    metadata: {
      ok: true,
      diagnostics: result.diagnostics,
      warnings: result.warnings,
      compatibility: result.compatibility,
      validation: result.validation,
      provenance: result.provenance,
    },
  };
}
