# Forge v0.1 beta release-candidate checklist

Version: `v0.1-beta-rc1` checklist schema. Completing this document does not create a tag or authorize release.

## Evidence record

- Candidate commit: **TBD by release owner**
- PR #24 merge commit: **TBD; PR is currently draft and unmerged**
- Exact-head CI run: **TBD for candidate**
- Static manifest `releaseSha256`: **TBD for candidate**
- Reviewer(s): **TBD**
- Operator/environment: **TBD**
- Decision date: **TBD**

## CI verification

- [ ] Node.js 22 install is reproducible with `npm ci`.
- [ ] TypeScript typecheck and build pass.
- [ ] Generator, syntax, composition, security, package, and reproducibility tests pass.
- [ ] Dependency audit passes at the agreed severity threshold.
- [ ] Static package contains only reviewed browser assets.
- [ ] Every packaged relative JavaScript import resolves inside the package.
- [ ] Two clean builds have identical manifests and byte-equivalent assets.
- [ ] Isolated Nginx syntax, route, MIME, cache, rejection, HTTPS, header, and CSP tests pass.
- [ ] Existing native Nginx fixture matrices pass on 1.24.0 and 1.26.3.

## Browser and product verification

- [ ] PR #24 is merged and exact post-merge release CI reruns.
- [ ] Chromium desktop/mobile smoke checks pass without CSP violations or overflow.
- [ ] Project owner approves PR #24 visuals and copy.
- [ ] Supported browser/version policy is explicitly approved; broader compatibility is tested accordingly.
- [ ] Keyboard-only, focus, artifact selection, stale-output, download, and ZIP workflows are reviewed.
- [ ] Landing and generator deep links are tested through the real static host.
- [ ] Accessibility review result and accepted residual issues are recorded.

## Validation distinctions

- [ ] CI verification evidence is recorded separately from deployed-host verification.
- [ ] Static website Nginx container tests are not represented as production-host validation.
- [ ] Native Nginx fixture tests are not represented as validation of every browser-generated file.
- [ ] Browser-generated configurations retain honest input/static/native/target-host status labels.
- [ ] Real target-server DNS, files, permissions, certificates, modules, firewall, and service reachability are checked by the operator.

## Deployment readiness

- [ ] Approved target environment and accountable operator are named.
- [ ] Candidate site files match the signed-off manifest after transfer.
- [ ] Document root points to the allowlisted site directory, never a repository checkout.
- [ ] HTTPS certificate chain, hostname, expiry, key permissions, and renewal owner are verified.
- [ ] Real-host `nginx -t` (or equivalent native check) passes and output is retained.
- [ ] Pre-traffic root/deep-route/assets/404/header/CSP/browser smoke passes.
- [ ] Access/error logging, monitoring, alerting, log retention, and incident ownership are approved.
- [ ] Atomic activation and previous-release rollback are reviewed for the target platform.
- [ ] Rollback target remains present and verified through the agreed observation window.

## Owner decisions — do not infer

- [ ] **Source license:** choose and add an approved license, or explicitly decide not to distribute publicly. No `LICENSE` exists at checklist creation.
- [ ] **Public domain/brand:** approve the real hostname, DNS ownership, and branding separately from technical readiness.
- [ ] **Privacy policy applicability:** decide based on hosting logs, cookies, analytics, CSP reporting, support channels, and applicable law. Current design adds no analytics or backend.
- [ ] **Telemetry/analytics:** remain disabled unless separately specified, privacy-reviewed, disclosed, and approved.
- [ ] **Supported browsers/accessibility threshold:** approve the compatibility and accessibility acceptance policy.
- [ ] **Operational ownership:** name the deployer, on-call/incident contact, patch owner, certificate owner, and log-retention owner.
- [ ] **Release authorization:** explicitly authorize merge, deployment environment, traffic change, tag, and public release as separate decisions.

## Go/no-go

- [ ] All blocking evidence is linked and outstanding risks are accepted by named owners.
- [ ] Human engineering review: **TBD**
- [ ] Product/visual review: **TBD**
- [ ] Security review: **TBD**
- [ ] Operator readiness review: **TBD**
- [ ] Final release authorization: **TBD**

Issue #9 must remain open until a separate release-candidate review and operator smoke test are complete.
