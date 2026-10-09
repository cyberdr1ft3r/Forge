# Nginx syntax engine — Phase 1

This phase implements the typed syntax foundation described in issue #14 and the design-only draft PR #15. It deliberately does not implement capability shelves, dependency planning, TLS, WebSockets, load balancing, UI changes, native validation, deployment, or migration of the existing Nginx generator.

Phase 2 now builds capability composition on this unchanged foundation; see [`NGINX_CAPABILITY_COMPOSITION_PHASE2.md`](NGINX_CAPABILITY_COMPOSITION_PHASE2.md). The Phase 1 profile, validation, and native-verification boundaries remain authoritative.

## Integration points

- `src/nginx-syntax/types.ts` defines Nginx-specific AST nodes, typed arguments, source provenance, and the `full-config` / `site-fragment` profiles.
- `src/nginx-syntax/registry.ts` is the closed, trusted source of directive names, serialized names, allowed contexts, argument grammars, repeatability, and canonical ordering. Callers cannot register arbitrary directives.
- `src/nginx-syntax/validator.ts` returns Forge `Diagnostic` records at the `static` tier. It checks output profiles, context placement, nesting, provenance, arguments, and supported duplicate/conflict cases.
- `src/nginx-syntax/serializer.ts` validates before rendering and emits standard Forge `OutputArtifact` objects. Future generator definitions can place these artifacts and diagnostics into the existing validate → normalize → generate → static validate → export lifecycle.
- `src/nginx-syntax/index.ts` is the public Phase 1 API. It remains separate from `src/generators/index.ts`, so the browser and the legacy `generateNginx` contract are unchanged.

## Profiles

- `full-config` requires exactly one `events` and one `http` block. Main-context directives may be siblings of those blocks. It emits `nginx.conf`.
- `site-fragment` requires one or more root `server` blocks and rejects `http`, `map`, `upstream`, or other root nodes. It emits `site.conf`, intended for inclusion from an existing `http` context.

Both profiles produce configuration text only. Forge does not write files, load them into Nginx, or claim that `nginx -t` ran.

## Security and determinism

- Directive and block names come only from the trusted registry.
- Arguments are discriminated values with bounded grammars for identifiers, domains, filesystem paths, literal HTTP(S) proxy URLs, upstream addresses, literal location prefixes, variables, headers, keywords, integers, literals, and quoted text.
- Control characters and raw syntax delimiters are rejected outside quoted values. Quoted values escape backslashes, quotes, and `$` to prevent unintended variable expansion.
- Paths are absolute, bounded, and traversal-free. Variables are allowlisted symbols.
- Siblings use registry order plus semantic keys, making equivalent directive/block sets render byte-identically. Map entries preserve author order because Nginx map matching precedence can be order-sensitive.
- Every node carries source provenance; validation diagnostics include stable codes and AST paths.

## Compatibility risks and limitations

- The directive registry is intentionally small. Unsupported directives are errors until a later reviewed phase adds their grammar and context rules.
- Location matching supports literal, absolute URI prefixes only. Exact, regex, named, and modifier-based locations are intentionally absent, and glob/query syntax is rejected rather than assigned unsupported semantics.
- `proxy_pass` accepts only literal `http://` or `https://` URLs in Phase 1; variable expressions and arbitrary snippets are not modeled. Upstream `server` entries accept only a host (or bracketed IPv6 address) with an optional port, never a URL or path.
- Duplicate checks cover single/keyed directives, location/upstream/map identities, map keys, and identical listener/server-name pairs. They are not a complete model of all Nginx inheritance or virtual-host precedence rules.
- Target Nginx version/module compatibility is not evaluated in Phase 1.
- The current generator continues using its proven legacy renderer. Migrating it before Phase 2 capability planning would create an unnecessary output-compatibility risk.
- Static success means the Forge model accepted the AST. It is not native parser verification or target-host readiness.
