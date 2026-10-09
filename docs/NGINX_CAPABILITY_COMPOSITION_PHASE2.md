# Nginx capability composition — Phase 2

Phase 2 turns the Phase 1 typed syntax engine into a deterministic capability planner. It remains a backend API: no Forge UI, legacy-generator migration, deployment agent, arbitrary directives, or native Nginx execution is included.

## Pipeline and integration

`composeNginxCapabilities()` owns this pipeline:

1. validate the request, target Nginx version/modules, capability IDs, and capability-owned input schemas;
2. resolve the selected dependency graph and reject missing dependencies, cycles, duplicates, incompatibilities, and unsupported targets;
3. obtain bounded semantic contributions from the trusted capability registry;
4. merge routes, listeners, TLS settings, WebSocket route augmentations, and shared HTTP resources by semantic identity;
5. materialize Phase 1 AST nodes with capability provenance;
6. run the Phase 1 context/grammar/conflict validator and deterministic serializer;
7. apply Forge artifact invariants and return artifacts, diagnostics, prerequisites, explanations, and separate input/static/native validation states.

The planner is under `src/nginx-composition/` and is independent of the UI, legacy Nginx generator, and syntax serializer. Capability order and route order do not affect artifacts or machine-readable explanations.

## Capability contract

Each immutable `NginxCapabilityDefinition` declares:

- stable identifier and semantic version;
- closed, versioned input schema with unknown properties rejected;
- required and incompatible capabilities;
- minimum Nginx version and required module identifiers;
- the AST contexts, directives, and blocks it may contribute;
- a runtime validator for untrusted input;
- a contribution function returning bounded route/server/shared-resource intent, prerequisites, explanations, and provenance.

The Phase 2 registry is closed to four IDs. Callers cannot register code, directive names, or raw configuration text.

## Supported capabilities

### Reverse proxy (`reverse-proxy`)

Requires an FQDN, literal target hostname/IP, and port. It establishes one application server and a root `/` proxy route. `proxy_pass` omits a URI so Nginx preserves the original request URI. Standard forwarded headers and explicit HTTP/1.1 proxying are emitted.

### Routing (`routing`)

Requires `reverse-proxy`. Supports 1–32 distinct literal-prefix routes with explicit targets. Each route selects one URI behavior:

- `preserve-prefix`: no URI is supplied to `proxy_pass`, preserving the original request URI;
- `strip-prefix`: the location must end in `/`, and a trailing `/` proxy URI replaces the matched prefix.

Regex, named, modifier-based, rewritten, or implicit routes remain unsupported. Duplicate literal prefixes are errors, including collision with the reverse-proxy root route.

### TLS and HTTPS redirect (`tls`)

Requires `reverse-proxy`, the `http_ssl` module, and explicit absolute certificate-chain and private-key file paths. Forge records file prerequisites but does not read, provision, validate, or protect those files. TLS 1.2 and 1.3 are emitted. Optional HTTP redirect creates a separate port-80 server and additionally requires `http_rewrite`; Forge never silently enables redirect behavior.

### WebSocket (`websocket`)

Requires `reverse-proxy`, `http_proxy`, `http_map`, and explicit existing route prefixes. It adds `Upgrade` and `Connection` headers only to selected routes and contributes one semantically deduplicated HTTP-scope upgrade map. Missing or duplicate route selections are errors.

`proxy_http_version 1.1` is explicit because the supported baseline includes Nginx releases before 1.29.7. Nginx documents WebSocket proxying from 1.3.13 onward.

## Output profiles

- `full-config` emits one primary `nginx.conf` with `events`, `http`, shared maps, and server blocks.
- `site-fragment` emits one primary `site.conf` containing server blocks only. When shared HTTP resources are required, it also emits supporting `http-shared.conf` and an explicit prerequisite to include it exactly once from the enclosing HTTP context.

The supporting file never contains an `http` wrapper, and `site.conf` never contains a `map`. Forge artifact validation still requires exactly one primary artifact.

## Explanations and provenance

Every AST node identifies the engine or capability that produced it. Composition explanations have stable codes, capability IDs, contexts, and semantic identities. They describe decisions such as prefix preservation, TLS listener creation, shared-map placement, and ancillary artifact emission without exposing upstream hosts or certificate contents.

## Security and bounded behavior

- capability selection is limited to 16 entries; the registry currently allows only one selection per capability;
- routing and WebSocket inputs allow at most 32 routes each, and the final plan allows at most 64 routes;
- domains, hosts, ports, literal prefixes, and certificate paths reuse Phase 1 argument grammars;
- certificate paths use a new non-globbing `file-path` grammar and reject whitespace, empty segments, traversal, control characters, and directive delimiters;
- route targets cannot contain schemes, paths, variables, or syntax delimiters;
- dependency cycles, missing dependencies/modules, duplicate capabilities/routes/listeners, and ambiguous merges fail without artifacts;
- raw Nginx directives and snippets are never accepted;
- the engine performs no file reads, network access, command execution, reload, or deployment.

## Verified Nginx semantics

The narrow registry additions follow the official Nginx documentation:

- [`proxy_pass`, `proxy_http_version`, and `proxy_set_header`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [WebSocket proxying and the HTTP-scope upgrade map](https://nginx.org/en/docs/http/websocket.html)
- [`map` HTTP-context rules](https://nginx.org/en/docs/http/ngx_http_map_module.html)
- [`ssl_certificate`, `ssl_certificate_key`, and `ssl_protocols`](https://nginx.org/en/docs/http/ngx_http_ssl_module.html)
- [`return` redirect semantics](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html#return)
- [`listen ... ssl`](https://nginx.org/en/docs/http/ngx_http_core_module.html#listen)

## Compatibility and limitations

- The target baseline remains Nginx 1.18+ for reverse proxy, routing, and TLS; WebSocket tunnel support is declared from 1.3.13. The selected target must explicitly report required modules.
- OpenSSL version, certificate contents, key permissions, DNS, upstream reachability, filesystem layout, include order, and target-host state are operator prerequisites, not verified facts.
- Scoped IPv6 zone identifiers, Unix-socket upstreams, upstream groups/load balancing, caching, rate limits, advanced rewrites, regular-expression locations, and arbitrary proxy variables are outside Phase 2.
- The legacy `generateNginx` API and UI remain unchanged. Migration requires separate compatibility work.
- Static success means Forge accepted the capability plan and AST. Phase 3 expands GitHub Actions into an **independent native `nginx -t` compatibility matrix** with positive and intentional negative fixtures; see [`NGINX_NATIVE_VALIDATION_PHASE3.md`](NGINX_NATIVE_VALIDATION_PHASE3.md). This is CI fixture evidence only: the browser engine still reports native validation as `unavailable` for a user's specific output, while composition results explicitly report target-host readiness as `not-run`.
- The declared target modules/version in a request are user-supplied assumptions, **not detected or verified** capabilities of the eventual destination host. A successful CI fixture does not confirm any user's Nginx modules, certificates, permissions, DNS, or runtime behavior.

## Architecture-reference reconciliation

The design-only draft predates the merged generator contract and refers to `site-fragments`; merged Phase 1 uses the singular `site-fragment` profile. Phase 2 follows the merged contract. It resolves the design question about HTTP-scope resources by emitting a deterministic supporting artifact rather than embedding an invalid `http`/`map` block in a site file.
