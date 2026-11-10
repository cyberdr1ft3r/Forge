# Forge

Infrastructure configuration generator prototype (v0.1).

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

## Static beta packaging

`npm run build:static` creates the allowlisted browser-only site under `release/site` and a SHA-256 content manifest at `release/forge-v0.1-beta-manifest.json`. The package contains `index.html`, `styles.css`, and only the compiled JavaScript dependency closure required by `/dist/app.js`; it excludes source, tests, source maps, declarations, repository metadata, documentation, and Node.js tooling.

The development server is for loopback development only. Do not expose the repository root or `server.js` as the public beta service. See [`docs/BETA_DEPLOYMENT.md`](docs/BETA_DEPLOYMENT.md) for the reviewed static Nginx deployment and rollback procedure.

Generator code is TypeScript compiled to `dist/` for the browser. The contract, lifecycle, extension guide, validation states, security boundaries, and migration policy are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Current limitations

- In-browser input validation is not a native Nginx, Docker Compose, or systemd validation.
- Native validators are described as unavailable unless the relevant executable actually ran successfully; Forge does not run them in the browser.
- The project is a prototype; review generated files before use.
- No server credentials or deployment automation are involved.

Built by cyberdr1ft3r.
