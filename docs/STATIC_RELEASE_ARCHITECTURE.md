# Forge v0.1 static release architecture

Status: beta release candidate design for Issue #9. This repository change prepares deployment assets; it does not deploy them.

## Release boundary

The public service is a static website. Node.js and `server.js` are build/development tools and are not part of the runtime. The Nginx document root must be the generated `release/site` directory (or an immutable transferred copy), never the repository root.

`npm run build:static` performs these deterministic steps:

1. compile TypeScript with the pinned project compiler;
2. start from the single module entrypoint declared by `index.html` (`/dist/app.js`);
3. follow only relative static JavaScript imports under `dist/`;
4. copy `index.html`, `styles.css`, and that compiled module closure to `release/site`;
5. reject imports that escape `dist/`, bare package imports, hidden files, source maps, TypeScript, or declarations;
6. write a sorted SHA-256 manifest outside the public root.

The manifest's `releaseSha256` is derived from each sorted public path and file digest. It contains no build time, hostname, absolute path, or other volatile metadata. Two clean builds are tested for byte-equivalent assets and identical manifests.

## Distribution structure

```text
release/
├── forge-v0.1-beta-manifest.json   # transfer/verification evidence; not public
└── site/                            # only this directory becomes the web root
    ├── index.html
    ├── styles.css
    └── dist/
        ├── app.js
        └── ...relative compiled JavaScript dependencies only
```

There are no runtime secrets or environment substitutions in the website. Forge remains client-side and local-first. Generated configurations are displayed or downloaded in the browser; they are not uploaded by this release architecture.

## Nginx boundary and route model

`ops/nginx/forge-beta.conf.template` is rendered with bounded values by `scripts/render-nginx-template.mjs`. It:

- redirects configurable HTTP traffic to a configurable HTTPS origin;
- serves exactly `/`, `/index.html`, `/styles.css`, required `/dist/**/*.js`, and the three generator routes;
- returns 404 for unknown routes, missing assets, hidden files, source files, repository/internal directories, and common private/configuration extensions;
- supplies CSS and JavaScript MIME types through the Nginx MIME table;
- sends HTML/deep routes with `Cache-Control: no-store` and unhashed CSS/JavaScript with a five-minute revalidation policy;
- disables autoindex and version tokens;
- applies a CSP compatible with same-origin ES modules and external CSS while disabling network connections, plugins, framing, forms, workers, and a permissive fallback;
- adds HSTS, MIME-sniffing, framing, referrer, permissions, and opener isolation headers.
- uses a minimal access-log format with client address, time, method, normalized path, protocol, status, and response bytes; it excludes query strings, referrers, user agents, and generated configuration content.

Certificate paths, server name, release root, ports, and public HTTPS origin are placeholders. A real certificate and private key must be provisioned outside the public root with least-privilege permissions.

## Trust and validation tiers

These checks are deliberately distinct:

- **CI verification:** compilation, unit tests, package allowlist, import closure, reproducibility, container route/header tests, and browser smoke tests.
- **Browser compatibility:** a limited Chromium desktop/mobile smoke test. It is not cross-browser product approval.
- **Native Nginx fixture validation:** existing generated-configuration fixtures run against pinned Nginx 1.24.0 and 1.26.3 images. This does not validate a deployed website host.
- **Static hosting validation:** the rendered website Nginx template is syntax/behavior tested in an isolated pinned container.
- **Generated configuration validation:** Forge's typed/static checks apply to user-generated infrastructure artifacts. Browser output still reports native validation unavailable unless a native tool actually ran.
- **Target-server readiness:** filesystem, certificates, DNS, permissions, modules, firewall, monitoring, and service health must be verified by the operator on the real target.

## Dependency on draft PR #24

This branch starts from `main` and does not merge or cherry-pick PR #24. Packaging is compatible with PR #24's `/dist/app.js` dependency graph and new `src/ui/zip.ts` module because the packager follows compiled relative imports automatically.

Before PR #24 merges, Nginx can return the entrypoint for `/generators/nginx`, `/generators/compose`, and `/generators/systemd`, but `main`'s browser application is not route-aware. Correct generator-specific deep-link rendering, the new landing page, ZIP UI, visual evidence, and PR #24's accessibility behavior therefore remain merge dependencies. Re-run the complete release CI and product review after PR #24 lands.

## Security scope

Tested attack paths include direct requests for `.git`, `.env`, source, tests, docs, package metadata, source maps, unknown routes, and missing assets; all are expected to return 404 from the isolated template. The public directory is also constructed by allowlist, so those files should not exist even if a future Nginx rule regresses.

This is defense in depth, not proof about a future host. The operator must verify the deployed root, symlink target, mounted files, Nginx includes, TLS posture, access logs, and external exposure before traffic changes.
