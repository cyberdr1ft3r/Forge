# Nginx upstream load balancing shelf — Phase 4B

## Contract

Phase 4B adds the trusted, versioned `upstream-load-balancing@4.1.0` capability. It declares one logical upstream identity and 2–16 typed backend servers. Reverse proxy retains its existing direct `{targetHost, targetPort}` target and may instead select exactly one declared `{upstreamId}`. Supplying both target forms, neither form, an unresolved reference, or an unused declaration fails closed.

```ts
[
  {id: 'reverse-proxy', input: {domain: 'app.example.com', upstreamId: 'app-pool'}},
  {id: 'upstream-load-balancing', input: {
    upstreamId: 'app-pool',
    strategy: 'round-robin',
    backends: [
      {host: '10.0.0.10', port: 8080, weight: 3, maxFails: 2, failTimeoutSeconds: 15},
      {host: '10.0.0.11', port: 8080, backup: true},
    ],
  }},
]
```

Logical IDs contain 1–31 lowercase letters, digits, or internal hyphens and render under the engine-owned `forge_` namespace. Backend hosts are validated hostnames, IPv4 addresses, or bracketed IPv6 addresses, always paired with a port from 1–65535. Duplicate endpoints and names colliding with the logical or rendered upstream identity are rejected. Unknown fields and raw Nginx parameters are never accepted.

The bounded optional backend controls are:

- `weight`: 1–100, default 1;
- `maxFails`: 0–10, default 1; zero disables failure-attempt accounting;
- `failTimeoutSeconds`: 1–300, default 10;
- `backup`: strict boolean, default false;
- `down`: strict boolean, default false.

At least two backends must not be marked `down`, and at least one enabled primary must remain. A backend cannot be both `backup` and `down`. These policy checks avoid emitting an effectively single-server group where Nginx ignores `max_fails` and `fail_timeout`, or a group with no selectable primary.

## Supported selection and failure semantics

`round-robin` is the default and uses Nginx's weighted round-robin behavior. `least-connections` emits `least_conn;`; Nginx selects the backend with the fewest active connections while accounting for weights, then uses weighted round robin for ties. Other algorithms are unsupported rather than approximated.

`max_fails` and `fail_timeout` are passive failure controls. What counts as a failure is determined by Nginx proxy retry policy. `backup` receives requests only when primary servers are unavailable, and `down` makes a backend permanently unavailable until configuration changes. Forge does not configure or imply Nginx Plus active health checks, dynamic service discovery, shared zones, slow start, runtime API changes, or live backend probes. See the official [`ngx_http_upstream_module`](https://nginx.org/en/docs/http/ngx_http_upstream_module.html) documentation.

## AST and composition integration

The capability emits a typed `upstream` block at HTTP context. The closed directive registry adds only `least_conn`, a bounded `server` parameter grammar, and a Forge-owned upstream URL argument for `proxy_pass`. No caller-provided directive name, parameter, URL, or snippet is concatenated into configuration.

Equivalent upstream blocks share the semantic identity `upstream:forge_<id>` and are emitted once across sites. The same identity with a different normalized AST fails as `composition.shared.conflict`. Distinct identities remain distinct. For a complete configuration, upstream blocks appear inside `http`; for `site-fragment`, they appear in the supporting `http-shared.conf`, which must be included once before `site.conf`.

URI forwarding remains unchanged: prefix-preserving proxy targets omit a proxy URI, while the existing strip-prefix behavior adds one trailing slash. TLS and WebSocket capabilities continue to alter listeners and location headers independently of whether the proxy target is direct or an upstream group. Existing direct reverse-proxy artifacts remain byte-identical.

## Operational prerequisites and validation limits

The target must use Nginx OSS 1.18.0 or newer with standard HTTP proxy/upstream functionality. Operators must verify DNS, routing, firewall policy, backend reachability, backend capacity, timeout/retry policy, and representative load/failure behavior before rollout.

Passing Forge input/static validation proves only the closed schema and AST invariants. CI runs `nginx -t` against immutable-digest-pinned official Nginx 1.24.0 and 1.26.3 images. Native parser success does not prove that backends are reachable or healthy, traffic will follow the intended production distribution, passive failure thresholds are appropriate, runtime connections will succeed, or a target host matches the CI images. The browser result continues to report native validation as `unavailable` and target-host validation as `not-run`.

Generation performs no network requests, backend probes, worker startup, deployment, reload, or restart. Rollback is a revert of the Phase 4B commit; there is no persistent application or infrastructure state.

## Remaining scope

This shelf does not add active health checks, keepalive tuning, request retry policy, sticky sessions, hash/random selection, dynamic DNS, Nginx Plus controls, logging, caching, compression, rate limiting, UI changes, or deployment behavior. Those require separate reviewed work.
