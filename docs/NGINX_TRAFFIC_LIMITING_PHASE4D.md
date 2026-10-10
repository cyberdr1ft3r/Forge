# Nginx request and connection limiting shelf — Phase 4D

## Contract and bounds

Phase 4D adds the trusted, versioned `traffic-limiting@4.3.0` capability. It requires an existing `reverse-proxy` or `static-site` owner and enables request limiting, connection limiting, or both.

```ts
{
  id: 'traffic-limiting',
  input: {
    policyId: 'public-api',
    requestLimit: {
      rate: 30,
      unit: 'minute',
      burst: 12,
      nodelay: true,
      zoneSizeMb: 8,
      statusCode: 429,
    },
    connectionLimit: {
      connections: 20,
      zoneSizeMb: 8,
      statusCode: 429,
    },
  },
}
```

The closed bounds are:

- `policyId`: 1–25 lowercase letters, digits, or internal hyphens, beginning with a letter;
- request rate: 1–10,000 requests per `second` or `minute`;
- burst: 0–10,000, default 0;
- `nodelay`: strict boolean, default false, and invalid when burst is zero;
- concurrent connection/request count: 1–10,000;
- each zone: 1–32 MiB, default 10 MiB;
- rejection status: exactly 429 or 503, default 429;
- total distinct traffic-zone allocation in one multi-site result: at most 256 MiB.

Unknown fields, coercible strings, arbitrary variables, raw directives, snippets, caller-rendered zone names, unbounded sizes, and unsupported statuses fail before generation.

## Request rate versus connection semantics

Request limiting uses Nginx's leaky-bucket implementation. The configured rate is an average processing rate, not a guarantee that accepted requests are evenly spaced. With a positive burst, excessive requests are normally delayed until capacity is available and are rejected only after the burst queue is exceeded. `nodelay` allows burst-capacity requests through immediately while still accounting for them; it does not increase the configured average rate. A zero burst emits no `burst` parameter and cannot use `nodelay`.

Connection limiting is a separate mechanism. Nginx counts a connection only while a request is being processed after its full request header has been read. For HTTP/2 and HTTP/3, each concurrent request is counted separately. It does not mean all open TCP sockets, authenticated users, application sessions, or upstream connections.

These semantics and contexts follow the official [`ngx_http_limit_req_module`](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html) and [`ngx_http_limit_conn_module`](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html) references.

Both controls use only `$binary_remote_addr`. Forge never trusts `X-Forwarded-For`, `Forwarded`, or another caller-selected header. Behind a load balancer, CDN, or reverse proxy, limits can collapse many clients onto the proxy address unless the operator separately configures and verifies Nginx's trusted real-client handling. That trust configuration is deliberately outside this shelf.

Per-IP controls can unfairly affect users behind NAT, allow one client to spread traffic across IPv6 addresses, and do not stop distributed attacks. They are resource-protection tools, not a DDoS guarantee, authentication control, user quota, or complete application abuse defense.

## Placement, inheritance, and redirects

`limit_req_zone` and `limit_conn_zone` are emitted only at HTTP scope. Enforcement and status directives are emitted at server scope on the owning primary application server, where current generated locations inherit them because they do not define their own directive of the same class. Nginx inherits request or connection limit directives from a previous level only when the current level defines none of that class.

When TLS redirect is enabled, the port-80 redirect server is intentionally not limited. Only the port-443 application server receives enforcement. This avoids consuming application admission state for a lightweight canonical redirect and is reflected in machine-readable explanations.

## Zone names, sharing, and memory

Forge renders separate names from the logical policy identity:

- request: `forge_req_<normalized-policy-id>`;
- connection: `forge_conn_<normalized-policy-id>`.

The prefixes prevent request/connection collisions. Two sites using the same `policyId` and identical zone definitions intentionally share counters and memory; equivalent nodes are emitted once with all dependent site IDs in provenance/explanations. The same identity with different rate or size fails as `composition.shared.conflict`. Different policy IDs remain isolated even when their numeric settings match.

Full configurations place zones directly in `http`. Fragment output puts zones in `http-shared.conf`, which must be included exactly once from the enclosing HTTP context before `site.conf`. Externally authored configuration must not reuse Forge-owned names. Multi-site composition sums distinct request and connection zones after deduplication and rejects plans over 256 MiB.

## Composition and operational prerequisites

The shelf composes with direct and load-balanced proxies, static/SPA sites, TLS, WebSockets, and logging. Capability and site order remain deterministic. When this capability is absent, existing artifact content is byte-identical.

Operators must verify:

- the target Nginx build includes the standard HTTP request- and/or connection-limit module selected by the policy;
- trusted real-client handling is correct before relying on IP identity;
- shared-memory capacity matches expected key cardinality and target architecture;
- rates, bursts, concurrency, latency effects, NAT fairness, and rejection behavior are capacity-tested;
- 429/503 responses and Nginx error logs are observable during a guarded rollout;
- the generated output passes `nginx -t` on the target and has an explicit rollback/reload plan.

Forge does not inspect a live host, allocate target memory, send traffic, deploy, reload, restart, or infer production readiness. Browser results keep native validation `unavailable` and target-host readiness `not-run`.

## Validation evidence and limitations

CI validates generated and intentionally malformed fixtures with `nginx -t` on immutable-digest-pinned official Nginx 1.24.0 and 1.26.3 images. It distinguishes parser rejection from stricter Forge policy rejection.

Worker-level behavioral tests are deferred. The existing hardened harness runs short-lived, read-only, network-isolated parser containers as an unprivileged UID and does not start Nginx workers or include a request client/backend. Adding timing and concurrent-request assertions there would weaken its isolation and introduce scheduler-sensitive results. Accordingly, this phase does not claim that runtime requests were throttled, that independent zones were behaviorally isolated, or that connection concurrency was exercised.

This phase does not add real-IP trust configuration, route-specific limits, dry-run controls, custom keys, multiple policies per site, user/account quotas, distributed state, Nginx Plus APIs, caching, compression, UI changes, deployment, or Phase 4E behavior. Rollback is a revert of the Phase 4D commit; Forge creates no persistent or target-host state.
