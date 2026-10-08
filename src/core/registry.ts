import type {GeneratorDefinition} from './types.js';

export class GeneratorRegistry {
  readonly #definitions = new Map<string, GeneratorDefinition<unknown, unknown>>();

  register<TInput, TNormalized>(definition: GeneratorDefinition<TInput, TNormalized>): void {
    const {id, contractVersion} = definition.manifest;
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(id)) throw new Error(`Invalid generator ID: ${id}.`);
    if (this.#definitions.has(id)) throw new Error(`Generator already registered: ${id}.`);
    if (contractVersion !== '1.0') throw new Error(`Unsupported generator contract: ${contractVersion}.`);
    const fields = definition.manifest.inputSchema.fields.map(field => field.name);
    const duplicateField = fields.find((field, index) => fields.indexOf(field) !== index);
    if (duplicateField !== undefined) throw new Error(`Duplicate input field in ${id}: ${duplicateField}.`);
    this.#definitions.set(id, definition as GeneratorDefinition<unknown, unknown>);
  }

  get(id: string): GeneratorDefinition<unknown, unknown> {
    const definition = this.#definitions.get(id);
    if (definition === undefined) throw new Error(`Unknown generator: ${id}.`);
    return definition;
  }

  list(): readonly GeneratorDefinition<unknown, unknown>[] {
    return [...this.#definitions.values()];
  }
}
