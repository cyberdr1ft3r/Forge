import type {GeneratorDefinition} from './types.js';

export class GeneratorRegistry {
  readonly #definitions = new Map<string, GeneratorDefinition<unknown, unknown>>();

  register<TInput, TNormalized>(definition: GeneratorDefinition<TInput, TNormalized>): void {
    const {id, contractVersion} = definition.manifest;
    if (this.#definitions.has(id)) throw new Error(`Generator already registered: ${id}.`);
    if (contractVersion !== '1.0') throw new Error(`Unsupported generator contract: ${contractVersion}.`);
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
