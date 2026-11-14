# M1-A Nginx Studio capability completion

Status: implemented on the isolated M1-A branch from M0 commit `9484621f30bf7f6abee98b832b5e437c78278732`. This document does not authorize merge, deployment, publication, or a release tag.

## Intended behavior

Nginx Studio now exposes the complete capability surface already implemented by the typed Nginx engine. A browser-only state adapter converts guided controls into `NginxMultiSiteCompositionRequest`; the UI does not serialize directives or accept raw configuration. The engine remains responsible for validation, normalization, dependency resolution, deterministic planning, static validation, and artifact generation.

Basic mode provides the common reverse-proxy or static-site workflow, domain ownership, direct upstream target, SPA behavior, TLS files, and HTTP redirect. Advanced mode adds bounded editors for:

- up to 16 sites and 256 routes across the request, with up to 32 routes per site;
- upstream groups containing 2–16 backend servers;
- weighted round robin or least-connections, weights, backup/down state, and passive `max_fails`/`fail_timeout` controls;
- per-route forwarding and WebSocket upgrade handling;
- combined, fixed Forge JSON, or disabled access logging plus explicit error logging;
- existing per-IP request-rate and connection limiting.

Dynamic controls use stable, non-user-derived editor keys. Add/remove actions preserve keyboard focus, engine diagnostics map back to the relevant control or site, and conflict or injection failures create no artifacts. Preview, per-artifact download, and multi-artifact ZIP export use the same successful engine result. Any field edit or collection mutation clears the prior result and requires regeneration.

## Assumptions and risk controls

- Generation remains browser-local. No input is sent, executed, deployed, reloaded, or used to inspect a host.
- Studio targets Nginx 1.26.3 with the declared `http_limit_conn`, `http_limit_req`, `http_log`, `http_map`, `http_proxy`, `http_rewrite`, and `http_ssl` modules. These are user-visible compatibility assumptions, not discovered host facts.
- Browser generation reports native validation as unavailable and target-host checks as not run. Only the separate pinned native harness may claim a successful `nginx -t` execution.
- Collection sizes and numeric values remain bounded by existing engine schemas. Submitted strings pass unchanged into typed validation; the adapter does not escape unsafe input into apparently valid directives.
- Advanced settings remain active when switching to Basic mode. Studio warns about this state so hiding controls cannot silently change generated configuration.

## Remaining Nginx capability gaps

M1-A completes UI parity with the current engine; it does not claim full Nginx coverage. Remaining product/engine work includes:

1. Reviewed cache policy, response/security headers, compression and body/upload limits.
2. Active health checks, dynamic service discovery, runtime retry semantics, and richer upstream protocols.
3. Authentication/authorization, mTLS client policy, certificate issuance/renewal, and secret-management integration.
4. Rewrite/redirect policy beyond the existing closed TLS redirect and route-forwarding semantics.
5. Runtime HTTP fixtures for every advertised behavior, especially WebSocket upgrades, limiting behavior and upstream failover; parser success alone does not prove runtime semantics.
6. A formally approved open-source Nginx version/module support policy beyond the current pinned parser matrix and Studio target assumption.
7. Host filesystem, permissions, DNS, process, certificate, log rotation/retention and service-readiness checks.

These gaps must remain unadvertised as supported capabilities until they have typed contracts, security review, deterministic tests, native/runtime evidence where applicable, and Studio mappings.
