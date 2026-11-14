# Milestone M0 integration review

Status: draft integration evidence for `codex/m0-repository-consolidation`, 2026-11-14. This review does not authorize merge, deployment, publication, tagging, or a release.

## Intended behavior, risks, and native-tool assumptions

M0 combines the reviewed roadmap, Nginx traffic limiting, browser Studio, and static packaging on an isolated branch based on `main` at `cb4f4bdaac2cd2505f8fe69fc0eddd67427043a3`. Generation remains browser-local and deterministic. Inputs are converted only to allow-listed typed capability requests; submitted configuration and shell text are never executed. Preview and export use the same validated outcome, and edits invalidate stale output.

The highest integration risks are mismatched UI-to-engine capability inputs, missing modules in the declared Nginx target, unsafe ZIP or public-package paths, mixed-version fixed-name assets, inherited access logging, and overstating native or target-host validation. The integration keeps Nginx core code DOM-independent, adds the traffic-limit module assumptions to the UI, retains strict ZIP and release allowlists, uses immediate asset revalidation, and preserves privacy-minimized HTTP/HTTPS logs.

Historical CI proves only the exact PR heads below. It does not prove this integrated head. Native Nginx evidence is valid only when the pinned container actually executes `nginx -t`. Browser-generated output continues to report native validation as unavailable and target-host readiness as not run. The static hosting container is not a production-host check. No native Docker Compose or systemd validation exists yet.

## Exact-head baseline

| PR | Exact head | Historical exact-head checks | Final review disposition |
| --- | --- | --- | --- |
| #23 traffic limiting | `3fc5292ebde07a088e9a01a644735fcc59558d69` | Actions run 38059754218: test and Nginx 1.24.0/1.26.3 jobs passed | Accepted for integration. Typed grammar, resource bounds, deterministic shared-zone merging, negative fixtures, and parser evidence are adequate for configuration generation. Runtime request/concurrency behavior remains explicitly unverified. Engineering 8/10; guarded staging readiness for the scoped engine, not release-ready alone. |
| #24 Studio UI | `0a63de1445d00cb30b070c1568831c08a2778928` | Actions run 42664691630: test, browser, and Nginx 1.24.0/1.26.3 jobs passed | Accepted for integration. Earlier focus, target-assumption, ZIP-integrity, stale-output, and visual-evidence findings were addressed at the exact head. Owner visual/copy approval remains a product gate. Engineering 8/10; staging ready. |
| #25 static packaging | `e387d9505234f710a49c62e1b6a3b633c1c75249` | Actions run 43053628996: test, static-release, and Nginx 1.24.0/1.26.3 jobs passed | Accepted for integration after source/test review. The latest head explicitly configures minimized redirect logging and immediate ETag revalidation for fixed-name assets, addressing both review findings. It still required an integrated rerun with the Studio dependency. Engineering 8/10; staging ready. |
| #26 production roadmap | `141fb2f88b631e2772fde907fc54fda3277d31f7` | Actions run 43639622632: test and Nginx 1.24.0/1.26.3 jobs passed | Adopted as the M0 development baseline. It authorizes no release action. |

GitHub REST review inspection found no newer code-review finding after the final #24 review. The two #25 inline findings remain visible historically but are addressed by commits `73998c2` and `e387d95` plus their exact-head checks. PR #23's description already uses `Refs #14` rather than a closing keyword. All source PRs remain open drafts and are not merged by this work.

## Integration decisions

- Preserve each PR's commits through merge commits on the isolated branch; do not force-push or modify the source branches.
- Keep `GeneratorDefinition` and the validate → normalize → generate → static validate → export lifecycle unchanged.
- Add the accepted traffic-limiting shelf to the Studio's allow-listed typed mapping, with `$binary_remote_addr` fixed by the engine and both limit modules declared in the assumed target.
- Keep `package.json` at its current development version until the M5 release-acceptance gate. Stable v1.0.0 packaging names are neutral and contain no beta label.
- Rename packaging assets to `forge-static-manifest.json`, `forge-static.conf`, `forge-static.conf.template`, `STATIC_DEPLOYMENT.md`, and `RELEASE_CHECKLIST_V1_0_0.md`.
- Keep the public root allowlisted to built browser assets. Manifests, templates, documentation, source, tests, repository metadata, and tooling remain outside it.

## Security review

No critical or high-severity source finding was found in the reviewed M0 scope. Tested defenses cover typed Nginx arguments, directive-injection rejection, ZIP filename safety, deterministic public-file closure, public-route rejection, CSP/security headers, minimized access logs, and cache revalidation. Residual risk is **medium** because user-generated Nginx is not executed in browser tests, target hosts are not inspected, runtime limiting semantics are not exercised, Compose/systemd lack native validators, and human accessibility/product approval is incomplete. Security rating: **8/10 for private staging**, not public-release approval.

## Remaining Nginx capability gaps

1. Existing typed logging, routing, upstream load-balancing, and multi-site composition are not yet exposed as complete editable Studio collections. Traffic limiting is mapped in M0; the remaining collection-based UI work belongs to M1.
2. The native harness validates parser acceptance/rejection but does not exercise worker-level request-rate or concurrent-processing behavior.
3. Security headers, request/body timeouts and limits, compression, and scoped caching with authenticated/private bypass are not implemented as typed shelves.
4. TLS termination presets, certificate lifecycle guidance, and bounded real-IP trust presets require design. Forwarded client headers must remain untrusted by default.
5. Supported open-source Nginx versions/modules need a reviewed support policy beyond the current 1.24.0/1.26.3 parser matrix and the Studio's declared 1.26.3 target.
6. Runtime fixtures remain needed for reverse proxy, redirects, static/SPA routing, WebSocket, load balancing, logging, traffic limits, and future caching behavior.

## M0 blockers after local implementation

- Exact integrated-head GitHub Actions must pass after the draft PR is opened.
- Human product/visual/accessibility approval is still required.
- M1 scope and the Nginx supported-version/module matrix require review.
- The advanced Compose and systemd structured-input proposal must be approved before implementation; neither engine is v1.0.0-complete.

## Local integrated evidence

Executed on the integrated worktree on 2026-11-14:

- `npm ci` — pass; lockfile install and audit reported zero vulnerabilities.
- `npm run typecheck` — pass.
- `npm test` — 102/102 pass, including positive, negative, injection-resistance, deterministic ZIP, static-package, and Nginx composition coverage.
- `npm run test:release` and `npm run verify:static` — pass; 23 public files, deterministic aggregate SHA-256 `1c9325a5ab9f6f32d14e8150a5914a8ea586f2915fb2b6ea07ff412e111a347b`.
- `npm run test:ui` — 18 pass, 2 intentional project-specific skips across desktop/mobile Chromium.
- Nginx 1.24.0 pinned digest — 50 positive, 28 native-negative, one parser-warning/policy rejection, and one parser-accepted/Forge-rejected fixture passed.
- Nginx 1.26.3 pinned digest — the same fixture counts passed.
- Isolated static Nginx — syntax plus route, log-privacy, rejection, MIME, immediate-revalidation, HTTPS, CSP, and security-header smoke passed.
- `npm run test:release:browser` — 8/8 desktop/mobile static-host tests passed.
- `npm audit --audit-level=high` — zero vulnerabilities.
- CI-equivalent `node --check` list — 17/17 files passed; `git diff --check` passed.

The first sandboxed browser attempt did not execute tests because the Playwright-pinned browser was absent. After installing Playwright Chromium revision 1254, the complete suite passed. The Windows native harness uses the official image's unprivileged numeric user `101:101`; Linux CI continues to use the invoking numeric UID/GID. Exact integrated-head GitHub Actions remains required after push.

