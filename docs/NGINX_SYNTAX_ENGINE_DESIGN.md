# Forge Nginx Composition Engine — Design preflight

Status: **proposal only**. Tracks [#14](https://github.com/cyberdr1ft3r/Forge/issues/14). No production implementation or native validation is included here.

## Current state and dependency

The existing Nginx generator renders one reverse-proxy site using string interpolation. The typed generator contract, registry, artifact model and validation records are proposed in draft PR #11, **not yet merged into main**. Implementation must be rebased on/reconciled with #11 once approved. Existing Nginx issues #3 (native correctness) and #7 (multi-file recipes) overlap with implementation; coordinate them to avoid parallel incompatible abstractions.

## Product requirements

Users pick a **starting scenario** (reverse proxy, static site, multiple routes, load balancing) and enable compatible **capabilities** (TLS, redirects, WebSockets, headers, logging, timeouts). The UI expresses user intent; it is not responsible for directive placement or string concatenation.

### Capability contract (concept)

Each capability declares:
- id, semantic version, supported Nginx version/module requirements
- input schema and safe defaults
- required companion capabilities and prohibited combinations
- structural contributions to a typed Nginx intermediate representation (IR)
- operator prerequisites (e.g. existing certificate/key paths)
- static checks, deployment guidance, and diagnostics

Examples:
- `reverse-proxy`: contributes a `location` and a target to a specific `server`
- `tls`: contributes a TLS listener and certificate/key references
- `websocket`: adds upgrade headers in proxy location, plus one deduplicated `http`-level upgrade map
- `redirect-to-https`: contributes an HTTP server with redirect; requires viable TLS target

## Syntax engine: typed IR, not generic snippets

Context families:
`main` -> `events`, `http`; `http` -> `map`, `upstream`, `server`; `server` -> `location`. A future `stream` family is separate.

Suggested conceptually typed nodes:

```ts
type Context = 'main' | 'events' | 'http' | 'server' | 'location' | 'upstream' | 'map';
interface DirectiveNode {
  kind: 'directive';
  name: KnownDirectiveName;
  args: readonly SafeArgument[];
  allowedContext: Context;
  sourceCapabilityId: string;
}
interface BlockNode {
  kind: 'block';
  blockType: Context;
  header: readonly SafeArgument[];
  children: readonly (DirectiveNode | BlockNode)[];
}
interface NginxPlan {
  profile: 'full-config' | 'site-fragments';
  roots: readonly BlockNode[];
  prerequisites: readonly Prerequisite[];
}
```

This sketch is **not the implementation contract**: avoid storing a user-controlled `allowedContext` or arbitrary directive name as authoritative. Context permissions are supplied by a trusted, versioned directive registry. Argument kinds must be explicit (domain, path, endpoint, literal, variable reference), and a renderer must serialize them according to the directive's grammar. Model Nginx variables only through allowlisted symbolic values.

## Pipeline

1. Validate raw shelf inputs against strict schemas.
2. Normalize values and build a dependency graph; reject cycles and unsatisfied requirements.
3. Resolve capabilities to AST contributions; combine by stable semantic keys (server_name/listener, location match, map id, upstream id).
4. Run structural/context/version/module/conflict checks.
5. Render deterministically into typed artifacts (plus prerequisites and per-file provenance).
6. Run independent native `nginx -t` checks in isolated fixture environments where supported.
7. Present evidence by tier: input, structural/static, native parser, and real-host verification (not automatically implied by previous tiers).

## Full config vs site fragments

- **full-config** emits complete `nginx.conf` with `events` and `http` hierarchy plus Nginx-compatible referenced paths.
- **site-fragments** emits server block files suitable for inclusion from an enclosing `http`, plus ancillary `http`-scope snippets when required. Never put a `map` inside a `server`/ `location`; never emit an `http` wrapper in `sites-enabled`.
- If a profile cannot safely express a capability, return a clear unsupported-profile diagnostic instead of a subtly invalid file.
- Ensure file names, file locations and include order are explicit. No write/deploy performed by Forge.

## Conflict and dependency examples

| Selection | Engine action |
| --- | --- |
| WebSocket for two proxy locations | Emit one `http` upgrade map and headers in relevant locations |
| HTTPS redirect but no TLS listener | Reject or add TLS only through explicit user confirmation |
| Two identical `location /api/` keys | Reject ambiguous overlap; do not quietly override |
| Multiple server blocks using same listener | Allow only if Nginx semantics and naming/default_server rules are sound |
| Multiple capabilities each adding `proxy_set_header Host` | Resolve scope and deduplicate; prevent accidental override |
| TLS configured without available certificate paths | Generate prerequisite warning; native-fixture verification needs valid test cert |
| Unsupported directive/module for chosen target | Reject with compatibility evidence or mark verification unsupported |

Note: Different `location` match types have precedence rules, so checking duplicate strings alone is insufficient. Some directives inherit differently; the engine must model scoped merges rather than blindly deduplicating every name.

## Native validation boundaries

Static checks test Forge's **model**, not the real parser. `nginx -t` in CI requires controlled installation/version, safe temporary paths, known fixture certificates and an isolated config prefix. Treat any validation requiring external resources as an environment prerequisite. Never load untrusted user files on a production Nginx process. Passing `nginx -t` does **not** prove correctness, security or target-host readiness.

## Threat model

- Input injection into directive names, paths, map variables, block syntax and location regexes.
- Duplicate directives that override security controls.
- Include/traversal paths and external file exposure.
- Version/module mismatch and invalid parser context.
- Resource abuse via oversized input, complex regex, capability explosions.
- False claims of native validation when only static checks ran.

Controls: allowlist grammar, bounded inputs, typed arguments, deterministic ordering, explicit unsupported states, fuzz/property testing, fixture-native parsing and no automatic reload/deploy.

## Test matrix (first implementation milestones)

- Known positive fixtures: HTTP proxy; HTTPS with existing test certs; HTTPS redirect; WebSocket with map; two sites sharing a map; routing variants.
- Negative fixtures: injected newline/brace/semicolon; map in `server`; duplicate location; redirect without TLS; unknown shelf; unsupported module/version; invalid certificate path; path traversal; conflicting directives.
- Determinism: reordered equivalent shelf selections render byte-identically.
- Native: targeted Nginx stable versions and declared modules, with `nginx -t` results attached to CI.
- Compatibility: legacy `generateNginx` behavior either kept through adapter or changed explicitly with migration notes.

## PR boundaries

1. **Design / this PR:** architecture, threat model, examples and phased milestones only.
2. **Core IR:** types, serializer, test matrix, safe argument registry.
3. **Capabilities:** reverse proxy, HTTPS/redirect, WebSocket and routing; conflict/dependency resolution.
4. **Native fixtures:** safe `nginx -t` CI coverage coordinated with #3.
5. **Catalog expansion:** static, upstream/load balance, rate limits, caching, logging, gRPC etc., each supported by separate fixtures.
6. **A4 workspace integration:** capability shelves and contextual inputs under #12, after contracts are stable.

## Open design questions for implementation PR

- Target Nginx OSS releases and module inventory?
- Should site fragments include an ancillary `http` directory or return a mandatory manual insertion plan?
- What exact source compatibility guarantees should legacy `generateNginx` keep?
- Which directive families merit typed support before an advanced freeform mode (if ever)?
- How should target-platform-specific paths (Debian sites-enabled, RHEL conf.d, Plesk custom configuration) be represented?

**Ready for implementation planning:** YES, after #11 is resolved and target/version/profile decisions are confirmed.
