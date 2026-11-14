# Nginx version and module support policy

Status: proposed for Forge v1.0.0, reviewed in M1-B on 2026-11-14.

Forge distinguishes a supported production target from legacy parser compatibility. A successful `nginx -t` on any CI image proves syntax acceptance only; it does not prove that a deployment host has the same build, modules, filesystem, certificates, upstream reachability, capacity, or runtime behavior.

## Supported lanes

| Lane | Version | Forge commitment |
| --- | --- | --- |
| Stable production target | 1.30.6 | Studio default, full unit/browser/native matrix, plus isolated HTTPS runtime behavior. Recommended default for Forge v1.0.0. |
| Mainline production target | 1.31.8 | Full unit/browser/native parser matrix. Supported for operators that intentionally track upstream mainline. |
| Legacy compatibility | 1.26.3 and 1.24.0 | Parser regression coverage only. These lanes are not a recommendation to deploy an unmaintained branch and receive no runtime-support commitment. |

Versions were selected from the official [Nginx download index](https://nginx.org/en/download.html) and [Nginx release news](https://nginx.org/) as checked on 2026-11-14. Before every Forge release, maintainers must re-check those sources, update immutable container digests, rerun the complete matrix, and review upstream security advisories. No floating Docker tag is accepted as CI evidence.

## Module policy

Forge's current closed capability set may require the standard open-source modules `http_gzip`, `http_headers`, `http_limit_conn`, `http_limit_req`, `http_log`, `http_map`, `http_proxy`, `http_rewrite`, and `http_ssl`. The composition request declares modules explicitly; a capability is rejected if its required module is absent. Third-party modules, dynamic module loading, arbitrary directives, Nginx Plus-only features, and executable templates/plugins are outside v1.0.0.

Relevant upstream directive contracts are the [HTTP core](https://nginx.org/en/docs/http/ngx_http_core_module.html), [headers](https://nginx.org/en/docs/http/ngx_http_headers_module.html), [gzip](https://nginx.org/en/docs/http/ngx_http_gzip_module.html), and [proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) module documentation.

## Evidence tiers

1. Forge input/static validation: closed schemas, typed AST arguments, context rules, dependencies, conflicts, deterministic serialization, and resource bounds.
2. Native parser: generated positive fixtures and deliberately invalid mutations run through the exact pinned `nginx -t` binary.
3. Isolated runtime: the stable lane starts an unprivileged, read-only Nginx container on a disposable network and verifies HTTPS security headers, HSTS, gzip/Vary, proxy response delivery, the request-body bound, and presence of bounded buffering output.
4. Target-host readiness: always `not-run` in the browser. Operators must separately validate their exact package/build and deployment environment.

Browser generation remains local and reports native validation as `unavailable`; it never executes Nginx or contacts a deployment host.
