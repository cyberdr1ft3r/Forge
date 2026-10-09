# Nginx static website and SPA shelf — Phase 4A

## Proposed contract and integration

Phase 4A adds one trusted `static-site` capability to the existing composition registry. It is not a generator and accepts no raw Nginx text.

```ts
{
  id: 'static-site',
  input: {
    domain: 'static.example.com',
    documentRoot: '/var/www/static-site',
    indexFile: 'index.html',
    spaFallback: false,
  },
}
```

`domain`, `documentRoot`, and `indexFile` are required. `spaFallback` is an optional strict boolean and defaults to `false` only when omitted. Unknown fields and coercible non-boolean values are rejected. Document roots are absolute, bounded, traversal-free directory paths without variables, whitespace, globs, or syntax delimiters. Index files are single safe filenames without slashes, variables, traversal, or directive delimiters.

The capability is a site owner alongside `reverse-proxy`: either can establish the exact server name and root location. Selecting both is ambiguous because both own `location /` and is rejected. `routing` and `websocket` continue to depend on `reverse-proxy`, so they cannot be attached to a static site. TLS no longer requires a proxy specifically; it requires exactly one trusted site owner, allowing static HTTP, static HTTPS, SPA HTTP, or SPA HTTPS without fake upstream input.

## Generated behavior

Static mode emits:

```nginx
root /var/www/static-site;
index index.html;
location / {
    try_files $uri $uri/ =404;
}
```

SPA mode changes only the final `try_files` argument to `/index.html`. Nginx checks the file and directory candidates under `root` in order, then internally redirects to the entry URI. Existing assets therefore resolve normally; client-side routes fall back to the entry document. Phase 4A does not claim missing asset-like URLs return 404 in SPA mode because they also follow the configured fallback.

`try_files` is represented by three typed arguments: two closed candidates (`$uri`, `$uri/`) and one validated fallback (`=404` or the derived `/indexFile`). Location headers remain literal prefixes, so unsupported regex, named, or modifier locations cannot be introduced.

## MIME and artifact behavior

Static sites contribute two shared HTTP resources: a trusted `include /etc/nginx/mime.types` and `default_type application/octet-stream`. Full configurations place them once inside `http`. Site-fragment output emits them once in supporting `http-shared.conf`; operators must include that file in the enclosing HTTP context before `site.conf`.

This path matches the official container images and is an explicit target-host prerequisite, not a detected fact. Custom installations may require an operator-reviewed path adjustment outside Forge until a separately designed typed portability contract exists.

## Filesystem prerequisites

Forge does not inspect or modify the target filesystem. Results explicitly require the operator to ensure:

- the document-root directory exists;
- every parent directory is traversable and hosted files are readable by the Nginx worker identity;
- the configured index file is deployed under the document root;
- static assets are deployed before traffic is enabled;
- `/etc/nginx/mime.types` exists and is readable, or the installation is adapted and natively revalidated.

These remain target-host `not-run` conditions even when committed fixtures pass `nginx -t` in CI.

## Compatibility and limits

Existing reverse-proxy, routing, TLS, WebSocket, single-site, multi-site, generator, and UI behavior remains unchanged. Capability and site order remain deterministic. Different sites may intentionally share a document root because listener/server-name ownership separates them; Forge does not infer deployment ownership from a path.

Phase 4A supports only one root static location per site. Mixed static/proxy sites, SPA plus proxy routes, custom error pages, aliases, directory listings, symlink policy, cache headers, compression, logging, load balancing, rate limits, arbitrary MIME paths, and runtime deployment are out of scope.

The behavior follows the official Nginx documentation for [`root`](https://nginx.org/en/docs/http/ngx_http_core_module.html#root), [`index`](https://nginx.org/en/docs/http/ngx_http_index_module.html#index), [`try_files`](https://nginx.org/en/docs/http/ngx_http_core_module.html#try_files), and normalized prefix-location matching in [`location`](https://nginx.org/en/docs/http/ngx_http_core_module.html#location).
