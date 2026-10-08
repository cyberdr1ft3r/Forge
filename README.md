# Forge

Infrastructure configuration generator prototype (v0.1).

Generate starter configurations for Nginx, Docker Compose and systemd. Configurations must be reviewed and natively validated before deployment.

## Development

```sh
npm run dev
npm test
```

Open http://127.0.0.1:4173.

## Current limitations

- In-browser input validation is not a native Nginx, Docker Compose, or systemd validation.
- The project is a prototype; review generated files before use.
- No server credentials or deployment automation are involved.

Built by cyberdr1ft3r.
