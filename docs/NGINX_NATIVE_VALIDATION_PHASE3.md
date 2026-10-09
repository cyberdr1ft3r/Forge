# Nginx native validation — Phase 3

Phase 3 adds independent native-parser evidence for the Phase 1 syntax engine and Phase 2 composition engine. It does not change capability behavior, migrate the legacy generator, validate a user's host, run Nginx workers, or deploy/reload configuration.

## Validation architecture

`tests/nginx-native-harness.mjs` is an explicitly invoked Linux CI harness. It:

1. accepts only a patch-version-constrained official image reference in the form `nginx:x.y.z`, optionally with an immutable SHA-256 manifest digest;
2. pulls the image and records its resolved repository digest;
3. captures `nginx -v` and `nginx -V`, confirms the binary version matches the tag, and fails closed if required module evidence is absent;
4. asks `composeNginxCapabilities()` to produce every positive artifact;
5. materializes full configurations and site bundles in a unique operating-system temporary directory;
6. creates a one-day, disposable self-signed certificate without logging its private key;
7. invokes only `nginx -t` in a constrained container and captures exit status, bounded stdout, stderr, duration, and meaningful parser diagnostics;
8. verifies deliberately invalid mutations fail for expected error fragments;
9. writes a JSON evidence report and removes the temporary tree in a `finally` block.

The harness never accepts a command, configuration snippet, or container option from a Forge request. Subprocesses use argument arrays with `shell: false` and a 30-second timeout. A timed-out named test container is forcibly removed.

## Compatibility matrix

CI runs the same fixture inventory against these immutable-digest-pinned official images:

| Image | Version line | Expected module evidence |
| --- | --- | --- |
| `nginx:1.24.0@sha256:f6daac…798c8` | 1.24 | HTTP core; SSL; proxy; map; rewrite |
| `nginx:1.26.3@sha256:41b194…8860` | 1.26 | HTTP core; SSL; proxy; map; rewrite |

The report records the actual binary version, complete configure arguments, and resolved image digest. SSL must have the affirmative `--with-http_ssl_module` configure flag. HTTP core, proxy, map, and rewrite are standard modules, so the harness fails if their exact `--without-*` configure flags appear. Successful positive fixtures then exercise their directives through the real parser. A declared `request.target.modules` array is never treated as installed-module evidence.

This matrix represents only the two listed official Linux images. It does not cover Nginx Plus, distribution-patched packages, Alpine/musl builds, dynamic third-party modules, Windows, custom builds, or the user's eventual host.

## Fixture inventory

Positive fixtures are unmodified Forge composition artifacts except for the explicit wrapper needed to include site artifacts in their required contexts:

- HTTP reverse proxy;
- HTTPS reverse proxy;
- canonical HTTP-to-HTTPS redirect;
- WebSocket reverse proxy;
- TLS plus WebSocket;
- multiple literal-prefix routes;
- prefix-preserving routing;
- prefix-stripping routing;
- complete `nginx.conf` with all Phase 2 capabilities;
- `site.conf` plus the supporting HTTP-context WebSocket map;
- byte-identical output from equivalent capability selections in different orders.
- two exact-name HTTP sites sharing port 80;
- two HTTPS sites sharing port 443 with separate disposable certificates;
- multiple WebSocket sites sharing one HTTP-level map;
- mixed HTTP, HTTPS, routed, and WebSocket sites;
- a multi-site fragment bundle with one ancillary HTTP file;
- byte-identical output from equivalent site-order permutations.

Negative fixtures are clearly labelled test-only mutations of a known-good artifact. They verify native rejection of:

- a `map` in an invalid directive context;
- duplicate/conflicting `proxy_pass` declarations;
- malformed `proxy_pass` arguments;
- a missing TLS certificate;
- a missing TLS private key;
- an unsupported directive (controlled missing-directive case);
- an HTTP-level include placed at main context;
- a site fragment incorrectly used as the top-level configuration.

Assertions match stable, meaningful fragments such as `directive is not allowed here`, `directive is duplicate`, `invalid number of arguments`, `cannot load certificate`, and `unknown directive`. Complete stderr text, process IDs, and temporary paths are intentionally not snapshot-tested.

The harness also records a separate policy-warning fixture: Nginx accepts a duplicate exact server name on one listener but warns that it is conflicting and ignored, while Forge rejects the request before serialization. This evidence is neither counted as a native parser failure nor presented as a supported Forge configuration. Multi-site behavior and remaining limits are documented in [`NGINX_MULTI_SITE_COMPOSITION.md`](NGINX_MULTI_SITE_COMPOSITION.md).

## Isolation and threat model

Each parser run has no network, a read-only container root, all Linux capabilities dropped, `no-new-privileges`, bounded memory/CPU/PIDs, and small writable, world-accessible tmpfs mounts that disappear with the container. It runs as the CI host's numeric UID/GID so it can read owner-only temporary fixtures without granting container root filesystem-override capabilities. A fixed command-line global directive places Nginx's test-only PID check in the isolated `/tmp` tmpfs rather than the image's root-owned `/var/run`; the cache tmpfs similarly permits Nginx's `-t` filesystem checks without opening host paths. The fixture directory is mounted read-only. The container entrypoint is bypassed and the only Nginx action is `-t`; no worker is started, no upstream connection is made, and no `-s`, reload, restart, package installation, production path, or deployment operation exists in the harness.

Docker image retrieval is the only network operation and occurs before the no-network parser container starts. CI's Docker daemon remains part of the trusted test environment. CI image references include immutable manifest digests, and the inspected resolved reference is retained in uploaded evidence for 14 days.

## Validation states

The four tiers remain separate:

| Tier | Meaning in the composition result |
| --- | --- |
| Input | Untrusted request and capability schema validation |
| Static | Forge AST, context, conflict, grammar, and artifact validation |
| Native | Parser execution for that individual result; still `unavailable` in the browser/composition API |
| Target host | Inspection of the eventual deployment host; explicitly `not-run` for composition results |

`ValidationSummary.targetHost` is an optional additive contract field, preserving existing consumers. Phase 2 outcomes populate it with a diagnostic explaining that installed modules, certificates, filesystem, permissions, external services, and host configuration were not inspected. Passing CI proves only that the committed fixtures parsed in the recorded containers.

## Reproduction

On an explicitly authorized Linux workstation with Node.js 22, Docker, and OpenSSL:

```sh
npm ci
npm run test:native:nginx -- --image nginx:1.24.0 --report native-validation-report.json
npm run test:native:nginx -- --image nginx:1.26.3 --report native-validation-report.json
```

Local/manual runs accept an exact patch tag such as `nginx:1.24.0`, optionally followed by an immutable `@sha256:` digest. Floating tags such as `latest`, `1`, or `1.26` are rejected, as are non-Linux hosts. A tag-only local run is patch-version constrained but does not provide immutable image provenance; supply a digest when byte-identical image provenance is required. CI compatibility evidence always uses immutable-digest-pinned references. The harness pulls the selected image, so reproduction requires registry access. The report contains parser output and compatibility evidence, not certificate contents or the private key.

## Limitations and follow-up

`nginx -t` checks syntax and attempts to open referenced files; it does not prove routing behavior, DNS resolution, upstream reachability, live TLS negotiation, certificate suitability for production, runtime permissions, deployment safety, or service health. Target-host readiness requires a separate authorized workflow under Issue #3. Additional supported image lines or custom module combinations should be added only with explicit support policy and trustworthy reproducible images.

Issue #14 Phase 4 may expand capability shelves only after human review of this phase. It must continue producing typed artifacts and must add matching static and native fixtures. No Phase 4 shelf is implemented here.

## Rollback

Revert the Phase 3 commit to restore the previous single-runner CI fixture. The change creates no persistent application data or deployed state. Uploaded evidence expires automatically; temporary files and containers are removed by the harness and Docker `--rm` behavior.
