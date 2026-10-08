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

Generator code is TypeScript compiled to `dist/` for the browser. The contract, lifecycle, extension guide, validation states, security boundaries, and migration policy are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Current limitations

- In-browser input validation is not a native Nginx, Docker Compose, or systemd validation.
- Native validators are described as unavailable unless the relevant executable actually ran successfully; Forge does not run them in the browser.
- The project is a prototype; review generated files before use.
- No server credentials or deployment automation are involved.

Built by cyberdr1ft3r.
