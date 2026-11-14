# Forge

Infrastructure configuration studio under development toward the stable v1.0.0 release.

Generate starter configurations for Nginx, Docker Compose and systemd. Configurations must be reviewed and natively validated before deployment.

## Development

```sh
npm install
npm run typecheck
npm run build
npm run dev
npm test
```

Open http://127.0.0.1:4173.

The landing page links to directly addressable workspaces at `/generators/nginx`, `/generators/compose`, and `/generators/systemd`. Nginx Studio uses the typed capability-composition engine for multi-site reverse proxy and static/SPA sites, route collections, WebSocket upgrades, upstream groups, weighted round robin or least-connections, passive failure controls, logging, TLS, traffic limiting, and complete/site-fragment output profiles. Docker Compose and systemd continue to use the versioned generator lifecycle.

## Static release packaging

`npm run build:static` creates the allowlisted browser-only site under `release/site` and a SHA-256 content manifest outside the public root. The package contains `index.html`, `styles.css`, and only the compiled JavaScript dependency closure required by `/dist/app.js`; it excludes source, tests, source maps, declarations, repository metadata, documentation, and Node.js tooling.

The development server is for loopback development only. Do not expose the repository root or `server.js` as a public service. See [`docs/STATIC_DEPLOYMENT.md`](docs/STATIC_DEPLOYMENT.md) for the reviewed static Nginx staging, activation, and rollback procedure.

Generator code is TypeScript compiled to `dist/` for the browser. The contract, lifecycle, extension guide, validation states, security boundaries, and migration policy are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Current limitations

- In-browser input validation is not a native Nginx, Docker Compose, or systemd validation.
- Nginx Studio intentionally supports a reviewed subset rather than raw directives. Active health checks, cache/header policy, compression, authentication, certificate automation, and arbitrary Nginx extensions are outside the current engine contract.
- Logging rotation, filesystem permissions, DNS/service reachability, certificate presence, and production-host readiness remain operator responsibilities.
- Native validators are described as unavailable unless the relevant executable actually ran successfully; Forge does not run them in the browser.
- Target-host files, permissions, modules, and service readiness are not inspected in the browser.
- The first public release is gated on the v1.0.0 roadmap; review generated files before use.
- No server credentials or deployment automation are involved.

Built by cyberdr1ft3r.
