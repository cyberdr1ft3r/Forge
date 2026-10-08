# Contributing to Forge

## Local development

Requires Node.js 22.

```sh
npm install
npm run typecheck
npm run build
npm test
node --check server.js
node --check dist/app.js
node --check dist/generators/index.js
npm run dev
```

The browser app is available at http://127.0.0.1:4173.

## Pull request workflow

- Choose an issue, create a dedicated branch, and keep changes narrow.
- Document observable behavior and the target program versions.
- Follow the versioned generator contract and lifecycle in `docs/ARCHITECTURE.md`; do not bypass validation or interpolate raw input.
- Add regression tests for normal, malformed, and adversarial inputs.
- Include exact test commands and their actual results.
- Explain native validation coverage, unsupported environments, security effects, and rollback steps.
- Do not merge unreviewed code or claim the output is production-safe solely because unit tests pass.

## Review checklist

- [ ] Scope matches linked issue
- [ ] No credentials, tokens, private keys, or personal data committed
- [ ] Tests and static checks executed
- [ ] Output reviewed for directive injection or quoting issues
- [ ] Any required native validation performed and distinguished from schema validation
- [ ] Rollback plan described

## Quality gate

The GitHub workflow checks JavaScript syntax, runs the Node.js unit tests, and checks that the development server serves the entrypoint. Branch protection and merge review policies must be configured separately by repository administrators.
