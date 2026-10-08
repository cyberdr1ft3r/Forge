export class GeneratorInputError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = 'GeneratorInputError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export class GeneratorExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GeneratorExecutionError';
    this.code = code;
  }
}
