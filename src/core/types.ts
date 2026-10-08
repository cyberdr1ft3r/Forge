export const GENERATOR_CONTRACT_VERSION = '1.0' as const;

export type GeneratorContractVersion = typeof GENERATOR_CONTRACT_VERSION;
export type ValidationStatus = 'passed' | 'failed' | 'not-run' | 'unavailable';
export type DiagnosticSeverity = 'info' | 'warning' | 'error';
export type DiagnosticStage = 'input' | 'static' | 'native' | 'generation' | 'export';

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly stage: DiagnosticStage;
  readonly message: string;
  readonly path?: string;
}

export interface ValidationRecord {
  readonly status: ValidationStatus;
  readonly diagnostics: readonly Diagnostic[];
  readonly validator?: string;
}

export interface ValidationSummary {
  readonly input: ValidationRecord;
  readonly static: ValidationRecord;
  readonly native: ValidationRecord;
}

export type SchemaFieldType = 'string' | 'integer' | 'boolean' | 'enum';

export interface InputFieldSchema {
  readonly name: string;
  readonly type: SchemaFieldType;
  readonly required: boolean;
  readonly description: string;
  readonly default?: string | number | boolean;
  readonly values?: readonly string[];
}

export interface InputSchema {
  readonly version: string;
  readonly fields: readonly InputFieldSchema[];
  readonly additionalProperties: false;
}

export interface OutputArtifact {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly role: 'primary' | 'supporting';
  readonly content: string;
}

export interface CompatibilityProfile {
  readonly technology: string;
  readonly versions: string;
  readonly platform?: string;
  readonly notes: readonly string[];
}

export interface NativeValidationCapability {
  readonly available: false;
  readonly tool: string;
  readonly reason: string;
}

export interface GeneratorManifest {
  readonly id: string;
  readonly displayName: string;
  readonly contractVersion: GeneratorContractVersion;
  readonly generatorVersion: string;
  readonly inputSchema: InputSchema;
  readonly compatibility: readonly CompatibilityProfile[];
  readonly nativeValidation: NativeValidationCapability;
}

export interface GenerationDraft {
  readonly artifacts: readonly OutputArtifact[];
  readonly diagnostics: readonly Diagnostic[];
  readonly deploymentSteps: readonly string[];
}

export interface GeneratorDefinition<TInput, TNormalized> {
  readonly manifest: GeneratorManifest;
  validate(input: unknown): TInput;
  normalize(input: TInput): TNormalized;
  generate(input: TNormalized): GenerationDraft;
  staticValidate(artifacts: readonly OutputArtifact[]): readonly Diagnostic[];
}

export interface GeneratorProvenance {
  readonly generatedBy: 'Forge';
  readonly contractVersion: GeneratorContractVersion;
  readonly generatorId: string;
  readonly generatorVersion: string;
  readonly deterministic: true;
}

export interface GenerationResult {
  readonly ok: true;
  readonly artifacts: readonly OutputArtifact[];
  readonly diagnostics: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
  readonly deploymentSteps: readonly string[];
  readonly compatibility: readonly CompatibilityProfile[];
  readonly validation: ValidationSummary;
  readonly provenance: GeneratorProvenance;
}

export interface GenerationFailure {
  readonly ok: false;
  readonly artifacts: readonly [];
  readonly diagnostics: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
  readonly deploymentSteps: readonly [];
  readonly compatibility: readonly CompatibilityProfile[];
  readonly validation: ValidationSummary;
  readonly provenance: GeneratorProvenance;
}

export type GenerationOutcome = GenerationResult | GenerationFailure;

export interface LegacyGeneratorResult {
  readonly filename: string;
  readonly content: string;
  readonly steps: readonly string[];
  readonly checks: readonly string[];
  readonly metadata: Omit<GenerationResult, 'artifacts' | 'deploymentSteps'>;
}
