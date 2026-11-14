# M1-B Nginx security and performance capabilities

M1-B adds four versioned (`1.0.0`) capability contracts to the existing validate → normalize → generate → static validate → export lifecycle. The UI never accepts raw directives, and disabled capabilities contribute no AST nodes, preserving byte-identical pre-M1-B output.

## Capability contract

- `security-headers`: fixed balanced or strict CSP presets; `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`; optional fixed HSTS profiles. All headers are emitted at application-server scope with `always`. HSTS requires TLS and is emitted only on the HTTPS application server, never the redirect server. Because Nginx `add_header` inheritance changes when a child context defines any header, future location-level header work must merge the complete inherited set rather than silently shadow it.
- `request-timeouts`: bounded `client_max_body_size`, client body/header inactivity timeouts, `send_timeout`, and optional proxy connect/send/read timeouts. Proxy connect is capped at 75 seconds to match the documented practical native limit. Proxy fields require a proxy-owning site.
- `compression`: gzip, an allowlisted and canonically sorted MIME set, minimum length, level, and Vary control. Forge warns that compressing secret-bearing responses with attacker-controlled reflection can create a side channel; operators must disable compression for such paths upstream.
- `proxy-buffering`: bounded request/response buffering with explicit memory and temporary-file ceilings, or a streaming profile that disables request and response buffering for SSE/streaming behavior. Streaming changes retry/replay and backpressure characteristics and is an operator-reviewed choice.

All numeric fields reject coercion, fractions, non-finite values, out-of-range resources, and extra properties. Header values are preset-only. Media types use a closed allowlist. Typed syntax arguments reject whitespace, separators, variables, comments, line breaks, and configuration injection.

## Composition and Studio behavior

The composition engine applies server-scoped contributions only to the application server. Multi-site assembly scopes provenance per site, deterministically sorts sites/directives, and rejects contradictory ownership before serialization. Full configs and site-fragment bundles share the same planner.

Studio exposes the capabilities only in the advanced workspace, with secure presets, contextual warnings, basic/advanced visibility, field-level diagnostic mapping, stale-output invalidation, live preview, and deterministic ZIP export. Its declared production target is Nginx 1.30.6 with required standard modules; this is an assumption, not host discovery.

## Known limitations

- CSP and Permissions-Policy are fixed presets, not an application-specific policy builder. Applications using inline code, third-party resources, frames, payments, cameras, or other integrations may require future typed policy composition.
- HSTS preload submission and subdomain readiness are external operator actions. Forge does not submit domains or discover HTTPS coverage.
- Compression exclusion by route/content sensitivity is not yet modeled; the safe warning is explicit, but application/upstream policy remains required.
- Buffer sizes are portable bounded values, not hardware-aware tuning. Disk capacity, concurrency, upstream behavior, SSE heartbeat timing, and WebSocket/application semantics remain environment-specific.
- Runtime CI covers representative stable-lane behavior, not load, slow-client timing, connection interruption, TLS policy fitness, or a production host.

See [NGINX_SUPPORT_POLICY.md](NGINX_SUPPORT_POLICY.md) for maintained and legacy coverage.
