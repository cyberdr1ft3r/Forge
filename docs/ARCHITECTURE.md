# Generator architecture

Forge contract version: **1.0**

## Why this exists

The prototype originally kept validation, normalization, rendering, user guidance, and the browser-facing return shape in one JavaScript file. That made three generators easy to demo, but every new technology would have expanded the same switchboard and duplicated lifecycle behavior. It also had no machine-readable compatibility, provenance, artifact, or validation-state model.

The current architecture keeps a small shared lifecycle and makes every technology an independently testable `GeneratorDefinition`. It is designed to allow multiple output artifacts and composition later, but this issue intentionally generates one primary artifact and does not implement composition, executable templates, dynamic plugin loading, or native tool execution.

## Directory structure

```text
src/
  app.ts                    Browser rendering and copy/download interactions only
  core/
    errors.ts               Typed public errors
    lifecycle.ts            Contract execution and legacy export adapter
    registry.ts             Explicit in-process generator registration
    types.ts                Versioned generator and result types
    validation.ts           Shared untrusted-input and artifact checks
  generators/
    nginx.ts                Nginx definition
    compose.ts              Docker Compose definition
    systemd.ts              systemd definition
    index.ts                Public API, registry, legacy adapters
tests/
  generators.test.js        Contract, regression, determinism, and attack tests
dist/                       Generated browser/Node JavaScript; never committed
```

## Contract and lifecycle

`GeneratorDefinition<TInput, TNormalized>` is the extension boundary. A definition exposes an immutable manifest plus four pure operations:

1. `validate(unknown)` treats all caller data as untrusted and returns typed input or throws a typed input error.
2. `normalize(input)` produces one canonical representation. Sorting, defaults, casing, and other deterministic canonicalization belong here.
3. `generate(normalized)` returns artifacts, generator diagnostics, and deployment guidance. It must not read time, randomness, environment variables, the network, or mutable global state.
4. `staticValidate(artifacts)` applies generator-owned substring/structural heuristics without parsing the target language and without claiming that a native parser ran.
5. The shared lifecycle applies artifact invariants and attaches compatibility, validation records, warnings, and provenance.
6. Export is a separate adapter. The current adapter selects the primary artifact and preserves the historic `{filename, content, steps, checks}` shape for the browser.

The result uses an artifact array today so a later issue can add related files without changing the top-level contract. Artifact ordering is significant and must be deterministic. Composition is deliberately absent until ordering, conflicts, provenance aggregation, and cross-generator validation have their own design.

## Manifest and versioning

Every manifest declares:

- stable generator ID and display name;
- generator contract version;
- generator implementation version;
- runtime-readable input schema with unknown properties disallowed;
- compatibility profiles;
- native validation capability.

Contract versions use a `major.minor` policy. A major change may remove fields, reinterpret lifecycle stages, or change result semantics. A minor change may add optional metadata or capabilities that 1.x consumers can safely ignore. Generator versions use semantic versioning independently: output-breaking behavior increments the generator major version, additive behavior increments minor, and safe fixes increment patch.

The registry rejects duplicate IDs and unsupported contract versions. Registration is explicit, not filesystem discovery or dynamic code execution. A future external plugin manifest should be declarative data validated against the manifest schema; loading executable third-party plugins is outside this trust boundary.

## Validation model

Each result records three distinct tiers:

| Tier | Meaning | Possible current state |
| --- | --- | --- |
| Input | Runtime validation and normalization eligibility | `passed` or `failed` |
| Static | Forge checks over generated artifact structure | `passed`, `failed`, or `not-run` |
| Native | The technology's real parser/validator | `unavailable` |

`tryGenerate` returns a structured success/failure outcome. The legacy functions throw on failure to preserve existing callers. A failed input never reaches normalization or generation. A static failure withholds artifacts from the public outcome. Native validation is always `unavailable` in this browser application; instructions such as `nginx -t`, `docker compose config -q`, and `systemd-analyze verify` are operator guidance, not evidence that the commands ran. A `passed` static state means only that Forge's deterministic artifact invariants and generator-specific structural heuristics found no error. It is not schema validation by, or a substitute for, the technology's parser.

## Security boundaries

- All input is untrusted. Objects reject unknown keys, and every interpolated value is allow-listed or safely encoded.
- Runtime validators reject values whose primitive type does not match the manifest. Optional fields apply their documented default only when omitted; malformed provided values never become defaults.
- Nginx domains and ports cannot add directives.
- Compose service names, image references, ports, and restart policies cannot add YAML nodes; emitted scalar values are JSON/YAML quoted where needed.
- systemd paths are absolute and traversal-free. Arguments are intentionally limited to space-separated literal tokens; control characters, quoting, shell operators, backslashes, and `%` specifiers are rejected.
- Shared artifact checks reject unsafe filenames, duplicate filenames, NUL/CR characters, missing artifacts, and missing trailing newlines.
- Generators never execute input, templates, shell commands, native validators, deployment commands, or network requests.
- Static validation is not a security certification or a substitute for review and native validation in the target environment.

## Adding a generator

1. Add one module under `src/generators/` with typed input and normalized models.
2. Define a complete immutable manifest and runtime schema. Prefer the shared validators; add a narrowly scoped validator when the target grammar differs.
3. Implement pure validation, normalization, generation, and static validation stages.
4. Represent output as ordered artifacts with one primary artifact. Do not create files or execute tools.
5. Register the definition in `src/generators/index.ts`. Add a legacy adapter only if the existing UI needs it.
6. Add exact-output/determinism, valid, invalid, injection, metadata, warning, error-state, and contract-compliance tests.
7. Document compatibility assumptions and the actual native validator command, while keeping native status unavailable unless a later trusted integration executes it.
8. Run `npm run typecheck`, `npm test`, JavaScript syntax checks, and the HTTP smoke test.

## Compatibility and migration

The three historic named exports and the `generators` map remain available after compilation. Their visible filename, content, deployment steps, and warning text remain compatible for valid browser inputs; an additive `metadata` field exposes the new contract result. The browser fields and copy/download workflow are unchanged. Generator manifests are the authoritative validation contract. The current browser field descriptors are presentation/compatibility data only and cannot weaken generator validation; making that UI fully manifest-driven belongs to the approved UI work in issue #12.

Malformed inputs are now intentionally stricter: unknown properties, non-matching primitive types (including string/number stand-ins for booleans), and invalid Compose restart policies are rejected instead of coerced, ignored, or defaulted. Browser-originated string ports remain supported and are normalized to integers. systemd arguments accept only literal tokens rather than ambiguous quoting or special syntax. These are correctness and injection-boundary changes. Users needing complex systemd escaping must edit and natively validate the generated unit outside Forge.

Rollback is a single revert of the architecture commit: no persistent data, remote resources, deployment state, or stored schema migrations are involved.
