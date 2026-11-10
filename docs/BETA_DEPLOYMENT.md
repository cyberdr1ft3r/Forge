# Forge v0.1 beta deployment and rollback guide

This is an operator dry-run guide. It does not authorize deployment and no command here should be run against a production host until the project owner approves the release and target environment.

## Prerequisites

- approved commit and recorded release-candidate decision;
- Node.js 22 and `npm ci` on the trusted build system;
- Nginx compatible with the tested template (isolated CI uses 1.26.3; existing Forge fixture CI also covers 1.24.0);
- a dedicated unprivileged deployment account and a web-server account with read-only access to release files;
- a public domain decision, DNS plan, firewall plan, and trusted HTTPS certificate owned by the operator;
- sufficient disk space for the new and previous immutable releases;
- access/error log collection, retention, alert ownership, and an incident contact;
- no repository checkout, `.git`, environment files, private keys, or build tooling under the public document root.

## Build and transfer

On a clean trusted checkout of the approved commit:

```sh
npm ci
npm run typecheck
npm test
npm run build:static
npm run verify:static
sha256sum release/forge-v0.1-beta-manifest.json
```

Review `release/forge-v0.1-beta-manifest.json`. Transfer only `release/site/` plus the manifest through the organization's approved integrity-protected channel. Keep the manifest outside the web root. On the target, run `node scripts/verify-static-manifest.mjs --root <transferred-site> --manifest <transferred-manifest>` from a trusted copy of the approved repository tooling before activation.

Suggested target layout (paths are examples, not mandates):

```text
/srv/forge/
├── releases/
│   ├── <previous-commit>/
│   └── <candidate-commit>/
└── current -> releases/<candidate-commit>
```

Create the candidate directory as a new immutable path. Do not copy over the active release. A reasonable baseline is directories owned by the deployment account and readable/executable by the Nginx group, files read-only to Nginx, and no group/world write access. Certificate private keys must remain outside `/srv/forge`, readable only by the privileged Nginx startup context, and never enter the repository or website artifact.

## Render and inspect the Nginx configuration

Set reviewed values in a non-secret operator session and render to a staging path:

```sh
FORGE_SERVER_NAME=beta.your-approved-domain.invalid \
FORGE_RELEASE_ROOT=/srv/forge/current \
FORGE_TLS_CERTIFICATE=/etc/letsencrypt/live/your-approved-domain/fullchain.pem \
FORGE_TLS_KEY=/etc/letsencrypt/live/your-approved-domain/privkey.pem \
FORGE_PUBLIC_ORIGIN=https://beta.your-approved-domain.invalid \
FORGE_HTTP_PORT=80 \
FORGE_HTTPS_PORT=443 \
node scripts/render-nginx-template.mjs --output release/forge-beta.conf
```

The `.invalid` example intentionally cannot be a production domain. Replace it only after the owner approves the public domain. Review the rendered file and integrate it through the host's normal Nginx configuration management; do not point Nginx at the repository root.

Before any traffic change, an authorized operator must run the real host's native configuration check (normally `nginx -t`) and record the command output, Nginx version/build modules, included configuration files, certificate validity, and resolved document-root symlink. CI's container check does not replace this.

## Pre-traffic verification

Test the candidate by an isolated listener, preview host, or local host-header override before switching public traffic:

- `/`, `/generators/nginx`, `/generators/compose`, and `/generators/systemd` return the approved entrypoint;
- unknown routes and missing assets return 404;
- `.git`, `.env`, TypeScript, maps, docs, tests, package metadata, and private configuration paths return 404;
- CSS and JavaScript have correct MIME types and `nosniff`;
- the CSP produces no violations during representative desktop/mobile flows;
- HTTP redirects to the approved HTTPS origin and the certificate chain/hostname are valid;
- HTML/deep routes are not cached and unhashed assets revalidate within five minutes;
- generated files are reviewed and their native validation/target-readiness labels remain accurate;
- access/error logs arrive at the approved sink without secrets or generated configuration content.

PR #24 must be merged and reverified before treating generator deep links or its Studio workflows as complete.

## Atomic activation

Where the platform supports atomic symlink replacement, prepare a new symlink and rename it over `current` in one filesystem operation. Record the previous target before changing it. Then perform the organization's approved Nginx configuration test and graceful reload procedure. These are manual, separately authorized production actions; this repository intentionally provides no automatic SSH, reload, DNS, or deployment pipeline.

Immediately run the operator checklist below. Stop and roll back on unexpected status codes, CSP errors, asset failures, certificate problems, missing logs, or generator workflow regressions.

## Rollback

1. Identify the recorded previous immutable release and confirm it still exists with its verified manifest.
2. Atomically repoint `current` to that release.
3. Restore the previous reviewed Nginx configuration if the configuration changed.
4. Run the native Nginx configuration check.
5. Perform the authorized graceful reload or platform switch.
6. Verify `/`, the three generator routes, required assets, TLS, security headers, 404 behavior, and logs.
7. Preserve candidate logs and manifests for incident review; do not delete evidence during response.
8. Record the rollback reason and block release authorization until it is reviewed.

Rollback does not undo DNS/CDN caches instantly. Their configuration and recovery procedures are environment-specific owner decisions and are not assumed here.

## Operations and maintenance

- Monitor Nginx availability, TLS expiry, 4xx/5xx rates, asset errors, CSP reports only if a privacy-reviewed reporting endpoint is later approved, disk capacity, and log delivery.
- Do not log query strings or browser-generated configuration content unless explicitly reviewed; the template uses ordinary Nginx logging defaults and adds no telemetry.
- Patch the host OS, Nginx, Node build image, GitHub Actions, and npm dependencies under the project's security process.
- Rebuild and reverify after dependency, compiler, UI, Nginx-template, or CSP changes.
- Rotate certificates and keys through the operator's secret-management process, never the web root or Git.
- Maintain at least one verified previous release until the rollback window closes.

## Operator checklist

- [ ] Owner approved license, domain, privacy-policy applicability, release candidate, and deployment environment.
- [ ] PR #24 merged and post-merge release CI/product review passed.
- [ ] Candidate commit and manifest recorded; transferred files match every digest.
- [ ] Public root resolves only to the candidate `site` directory.
- [ ] Ownership/permissions prevent web-server writes and protect TLS keys.
- [ ] Domain, DNS, certificate chain, hostname, and expiry verified.
- [ ] Real-host Nginx version/modules/includes recorded and native configuration test passed.
- [ ] Root, generator routes, assets, 404 negatives, MIME, cache, CSP, and security headers verified.
- [ ] Desktop/mobile and owner-approved browser matrix completed.
- [ ] Access/error logs, monitoring, alert owner, and incident contact verified.
- [ ] Previous release target and rollback procedure rehearsed or reviewed.
- [ ] Explicit release authorization recorded before traffic or reload changes.
