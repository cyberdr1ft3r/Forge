# Nginx access and error logging shelf — Phase 4C

## Contract

Phase 4C adds the trusted, versioned `logging@4.2.0` capability. It requires an existing site owner (`reverse-proxy` or `static-site`) and applies one explicit access-log policy plus one error-log policy to every server owned by that site, including an optional HTTP-to-HTTPS redirect server.

```ts
{
  id: 'logging',
  input: {
    accessLog: 'forge-json',
    accessLogPath: '/var/log/nginx/app.access.log',
    errorLogPath: '/var/log/nginx/app.error.log',
    errorLogLevel: 'warn',
  },
}
```

`accessLog` is exactly `combined`, `forge-json`, or `off`. An enabled access log requires an absolute `accessLogPath`; `off` forbids that field and emits `access_log off`. `errorLogPath` is always required. `errorLogLevel` defaults to `error` and accepts only `info`, `notice`, `warn`, `error`, `crit`, `alert`, or `emerg`. Forge intentionally excludes `debug`, which depends on a debug-enabled Nginx build and can expose substantially more operational data.

Paths use the closed non-globbing file-path grammar. Relative paths, traversal or dot segments, empty segments, trailing slashes, whitespace, control characters, variables, globs, and Nginx delimiters are rejected. Access and error output cannot target the same file. Callers cannot supply directive names, format names, format strings, arbitrary variables, syslog destinations, or raw snippets.

## Access formats and privacy boundary

`combined` selects Nginx's built-in combined format explicitly. Because that built-in format records the request line, it can include URL query strings. `forge-json` selects the namespaced `forge_json_v1` format and contributes one HTTP-scope declaration using `escape=json`. Its fixed fields are timestamp, remote address, host, method, normalized URI path, status, bytes sent, and request duration. The JSON preset deliberately excludes authorization headers, cookies, request bodies, referrers, user agents, raw request lines, and query arguments.

Even the restricted JSON preset can capture sensitive URL paths or host names, while `combined` can additionally capture query strings. Operators must review application routing and privacy requirements, restrict log access, choose appropriate retention, and avoid putting secrets in URLs or query parameters. Forge does not promise that log data is non-sensitive.

Nginx writes a request to the access log of the context where request processing ends. Server-level directives therefore provide a predictable site default while allowing existing generated locations to inherit it. Phase 4C does not emit location-level overrides because none of the current capability contracts has a safe, explicit need for one. A future location-level feature must model final-location behavior rather than assuming the initially selected location owns the log record.

## Shared resources, multi-site behavior, and profiles

The JSON `log_format` directive is legal only in HTTP context. Full configurations place it once in the generated `http` block. Site fragments place it in `http-shared.conf`, which must be included exactly once from the enclosing HTTP context before `site.conf`.

Multi-site composition deduplicates identical `forge_json_v1` declarations by semantic identity, with provenance recording all dependent sites. A contradictory declaration using the same owned identity fails closed. Each site's server-level paths, preset selection, and severity remain independent. A site using `combined` or `off` does not create a shared format declaration.

The format name is reserved inside Forge, but an operator can still create an external collision by combining Forge output with a separately authored `log_format forge_json_v1` declaration. Include ownership and ordering remain deployment concerns; operators must not declare the reserved name elsewhere.

## Operational prerequisites and limitations

Forge records, but does not satisfy, these prerequisites:

- parent directories exist and the Nginx runtime identity can create or append to the files;
- file and directory permissions prevent unauthorized disclosure or modification;
- external rotation and retention are configured and tested, including reopen/signalling behavior;
- filesystem capacity and log ingestion throughput are monitored;
- downstream consumers treat log fields as untrusted data and parse JSON safely.

Generation performs no filesystem writes, permission changes, file creation, rotation, request generation, worker startup, reload, restart, or deployment. It does not support conditional logging, sampling, buffering controls, compression, syslog, dynamic paths, custom formats, custom fields, location-level overrides, or commercial structured `error_log` output.

CI runs `nginx -t` against immutable-digest-pinned official Nginx 1.24.0 and 1.26.3 images. Positive fixtures cover proxy, static, TLS/redirect, WebSocket, upstream, multi-site, and fragment combinations. Negative fixtures and Forge-policy tests cover context, grammar, identity, severity, and path attacks. The harness does not start workers, so it does not claim to verify that requests produce expected lines. Browser results continue to report native validation as `unavailable`, and target-host readiness remains `not-run`.

The capability is additive: when `logging` is absent, existing composition artifacts remain byte-identical. The legacy Nginx generator and approved UI are unchanged. Rollback is a revert of the Phase 4C commit; no persistent Forge or deployment state is created.
