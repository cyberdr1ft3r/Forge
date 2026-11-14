# Shared structured-input architecture proposal

Status: M0 design proposal for the advanced Docker Compose and systemd engines. No engine behavior or schema migration is implemented by this document.

## Decision

Add a versioned, JSON-compatible structured field model to the existing `GeneratorDefinition` contract. Preserve the current lifecycle and `GenerationOutcome`; multi-file results continue to use `OutputArtifact[]`. Do not add executable templates, callbacks in imported data, raw directive fields, or generator-specific secondary return shapes.

The same structural vocabulary should serve Compose services/networks/volumes and systemd services/timers while each generator owns its semantic validation and normalization.

## Contract shape

```ts
type SchemaVersion = '1';

type InputSchemaNode =
  | ScalarSchema
  | ObjectSchema
  | CollectionSchema;

interface ObjectSchema {
  readonly kind: 'object';
  readonly fields: readonly InputField[];
  readonly additionalProperties: false;
}

interface CollectionSchema {
  readonly kind: 'collection';
  readonly item: ObjectSchema;
  readonly minimumItems: number;
  readonly maximumItems: number;
  readonly identityField?: string;
  readonly order: 'preserve' | 'sort-by-identity';
}

interface StructuredGeneratorInput {
  readonly schemaVersion: SchemaVersion;
  readonly generatorId: 'compose' | 'systemd';
  readonly generatorVersion: string;
  readonly value: Readonly<Record<string, JsonValue>>;
}
```

`ScalarSchema` extends the current string/integer/boolean/enum model with explicit bounds, formats, defaults, and secret/reference classification. Objects reject unknown keys. Collections have hard cardinality limits and, when applicable, a constrained identity field. Schema nodes are passive data; they cannot contain executable validators or rendering code.

## Lifecycle

1. **Validate envelope:** require exact `schemaVersion`, `generatorId`, and supported `generatorVersion`; reject unknown envelope keys.
2. **Validate structure:** recursively enforce node kind, required fields, exact object keys, scalar types, bounds, collection limits, and safe identifiers. Never coerce strings to booleans or numbers.
3. **Normalize:** create a new immutable generator-owned domain model. Normalize case only where the target specification defines case-insensitive identity. Sort only collections declared `sort-by-identity`; preserve semantic order such as command arguments.
4. **Validate relationships:** check duplicates, references, cycles, port collisions, unit dependencies, mutually exclusive settings, resource budgets, and high-risk combinations.
5. **Generate:** serialize through target-specific safe emitters. Do not concatenate untrusted YAML, shell, systemd, or Nginx snippets.
6. **Static validate:** parse or structurally inspect the produced artifacts independently of the renderer where practical.
7. **Export:** return one or more versioned `OutputArtifact` records plus accurate validation states and prerequisites.

## Shared UI adapter

The browser may render scalar, object, and collection editors from the passive schema. It must keep stable item identities separate from array indexes, preserve user values across conditional rendering, and invalidate all prior artifacts when any semantic value changes. UI helpers convert form controls into JSON-compatible values only; they do not perform engine normalization or emit configuration text.

Collection editors need explicit add/remove controls, maximum-count feedback, keyboard-accessible reordering only when order is semantic, and per-item diagnostic routing using paths such as `value.services[1].ports[0].hostPort`. Preview/export remains disabled until the engine returns a successful outcome.

## Compose domain mapping

The top-level model contains bounded collections for services, networks, and volumes plus optional project metadata. Service identities are stable constrained names. Nested collections cover ports, environment references, mounts, dependencies, healthcheck tokens, profiles, and security options.

Normalization resolves references to canonical identities and produces a deterministic ordering without changing command/entrypoint token order. Semantic validation rejects unknown references, dependency cycles, duplicate/colliding ports, unsafe bind paths, unsupported interpolation, secret values in exportable fields, and denied high-risk combinations. Public bindings, host networking, privileged mode, Docker socket access, broad host mounts, root execution, and mutable tags require explicit policy outcomes; unsupported dangerous combinations fail closed.

Artifacts are `compose.yaml`, optional `.env.example` containing placeholders only, and an operator README. Native status may pass only after the declared pinned `docker compose config -q` command succeeds for the generated trusted fixture.

## systemd domain mapping

The top-level model contains bounded collections of service and timer units. Each service has typed executable/argument tokens, identity, user/group, directories, environment references, restart/time limits, dependencies, install targets, resource controls, and hardening settings. Timers reference a generated service and use typed calendar or monotonic schedules.

Normalization assigns canonical `.service`/`.timer` names and deterministic dependency ordering while preserving `ExecStart` token order. Validation rejects duplicate units, missing references, generated-bundle dependency cycles, newline/control-character injection, unsupported specifiers or expansions, shell execution, unsafe environment values, incompatible service types, invalid calendars, and unacknowledged root execution. Hardening presets expand into explicit reviewed fields rather than opaque snippets.

Artifacts are individual unit files plus install/verify/status/rollback instructions. Native status may pass only after the declared supported `systemd-analyze verify` and calendar checks actually execute successfully against trusted fixtures.

## Compatibility and migration

- Existing scalar generator inputs remain supported by their current generator versions. The new structured engines use new major `GeneratorDefinition.version` values and register alongside, or replace only through an explicit registry migration.
- Provide pure `migrateLegacyComposeInput()` and `migrateLegacySystemdInput()` functions that accept only the exact old schema and return the new envelope. They must not guess missing high-risk settings.
- Migration output is revalidated through the new structured validator before generation.
- Golden compatibility tests assert that supported legacy examples retain equivalent primary configuration semantics, while changes in artifact layout or safer defaults are documented.
- Unknown schema/generator versions fail with an actionable diagnostic; there is no best-effort downgrade.

## Required tests before implementation acceptance

- Positive unit tests for minimum and maximum collection shapes, multi-artifact output, references, deterministic ordering, and legacy migration.
- Negative tests for unknown keys, wrong primitive types, empty/oversized collections, duplicates, missing references, cycles, collisions, incompatible options, and resource ceilings.
- Injection-resistance tests for newlines, YAML tags/anchors, Compose interpolation, dollar escaping, shell metacharacters, systemd specifiers/expansion, path traversal, unsafe ZIP names, and secret-like values.
- Property-style determinism tests: equivalent normalized inputs produce byte-identical artifacts; repeated generation does not mutate inputs.
- UI tests for collection add/remove/reorder, per-item diagnostics, stale-result invalidation, keyboard focus, mobile layout, and exact ZIP contents.
- Native CI matrices with pinned tool versions/digests and evidence reports that record command, tool version, fixture identity, exit status, and artifact digest. Native fixtures must be trusted repository data and isolated from production resources.

## Open review decisions

1. Exact supported Compose v2, systemd, Ubuntu LTS, and enterprise Linux versions.
2. Whether legacy generators remain selectable during one migration window or are replaced atomically before v1.0.0.
3. Policy for explicit public port binding and other high-risk-but-valid settings: warning plus acknowledgement versus deny in v1.
4. Whether local project persistence is in v1 scope; if accepted, it needs separate privacy, schema-upgrade, and untrusted-import review.
5. Scope of Issues #7 and #8. Cross-engine orchestration and import/audit must not be inferred from this shared schema.

