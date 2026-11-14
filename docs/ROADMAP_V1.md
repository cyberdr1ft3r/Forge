# Forge v1.0.0 — production release roadmap

Status: proposed engineering plan, 2026-11-14. First public release is stable v1.0.0; no public beta. Internal staging and release verification are not public releases. This document supersedes earlier beta-oriented planning upon approval, not existing technical/security requirements. No release authorized by this document.

## Evidence baseline

Main: cb4f4bdaac2cd2505f8fe69fc0eddd67427043a3. Merged PRs #10, #11, #16–22 establish versioned generator lifecycle, Nginx AST/validation/planning, multi-site, static/SPA, upstreams, logging and native parser CI. Open drafts: #15 historical design, #23 rate/connection limiting, #24 Studio UI, #25 static packaging. All target main; #25 explicitly depends on #24 despite independent branches; #24 excludes #23. GitHub reported #23–25 individually mergeable at audit time; combined compatibility not established. PR-reported test results are historical, not a new test execution.

Main README and package.json still describe v0.1. Main src/generators/compose.ts supports one named image service, one loopback port and restart policy; static validation uses string inclusion. Main src/generators/systemd.ts supports one simple service with user, directory, executable and literal arguments, fixed restart and two hardening directives; static validation also uses string inclusion. Core schema currently lists scalar fields only. Main CI has unit/build/audit/smoke gates and pinned Nginx 1.24/1.26 native parser jobs, without native Compose or systemd jobs. UI and static packaging are not merged. No fresh test run or exhaustive line-by-line security review performed in this audit.

## Product boundary

Browser-local, deterministic generation; no accounts, backend, telemetry, server credentials or execution of submitted configurations. Three fully usable workspaces, not three placeholder forms. Production-oriented files for a documented supported subset, never a claim to support every directive or certify a target host. No new public beta. Import/audit (#8) and cross-engine orchestration (#7) require a separate scope decision; independent multi-artifact export is required in v1.0.0. No arbitrary executable plugins, raw configuration injection or host deployment automation.

## Milestones (ordered gates)

### M0 — consolidate existing work (#1, #3, #6, #9, #12, #14)
- Review exact heads, unresolved review threads and CI; reconcile #15 against implemented design; do not close or merge without review.
- Review #23 and #24 independently; integrate with conflict resolution, update UI mappings for all accepted capabilities, then rebase/reconcile #25. Rename beta-specific deployment files and references consistently; preserve security and reproducibility checks. Keep each change in focused PRs, no force push.
- Use current main as baseline; preserve generator contract and DOM-independent core; propose a versioned additive structured input model with explicit compatibility/migration tests before Compose/systemd work.
- Gate: integration branch builds, all existing tests pass, native and browser jobs pass at exact head; documented dependency graph and approved scope.

### M1 — finish Nginx (#3, #14)
- Expose existing HTTP/TLS redirect, reverse proxy, WebSocket, static/SPA, multi-site, upstream/load balancing, logging and reviewed rate/connection limits in usable UI.
- Add typed security headers, timeouts/body limits, compression, scoped caching with explicit cache bypass for authenticated/private traffic; evaluate TLS termination/certificate path and real-IP trust presets. No default trust of forwarded headers; no unsafe directives or blanket cache of private data.
- Specify supported open-source Nginx versions and module assumptions; native parser matrix plus isolated runtime HTTP fixtures for reverse proxy, redirects, static/SPA, WebSocket, routing, rate limiting and caching semantics.
- Gate: full config and fragment profiles, shared artifacts, deterministic output, conflict and injection regression coverage, accurate diagnostics, no unsupported capability advertised.

### M2 — Docker Compose stack engine (#4, #13)
- Define typed multi-service model: images/build (explicit local context constraints), command/entrypoint, ports (loopback default, public binding explicit), environment references, env_file, networks, named volumes/bind mounts, dependencies/conditions, healthchecks, restart, profiles, resource limits and security options.
- Validate references, duplicates, dependency cycles, port collisions, mount safety, YAML scalar escaping and Compose interpolation. Distinguish literal dollar signs from intentional variable references. Use deterministic safe serialization and structural validation rather than substring checks.
- Secure defaults and explicit risk warnings for privileged mode, host networking, Docker socket, broad mounts, root and mutable tags; deny unsupported high-risk configurations rather than silently weakening controls. Secret references/placeholders only; no secret values in fixtures or exports by default.
- Artifacts: compose.yaml, optional .env.example and deployment README; presets for web+database and reverse-proxy-connected app with documented prerequisites, no implicit public database ports.
- Gate: pinned Compose v2 compatibility matrix using docker compose config -q and resolved model assertions; isolated trusted-fixture runtime smoke for dependency/health/network behavior; negative and injection tests; multi-service UI and export.

### M3 — systemd engine (#5)
- Define typed service and timer models with service types simple/exec/oneshot as supported by target version; user/group, working directory, executable and argument tokens, environment references/files, restart policy/limits, timeouts, dependencies, installation targets, journal output, resource and hardening controls.
- Timers: OnCalendar/monotonic schedules, associated service, persistence where applicable, install target. Validate unit names, references, cycles within generated bundle, directive context, incompatible settings, specifier and environment expansion/escaping, injection and root execution risks.
- Hardening presets with explicit filesystem/network permissions; do not blindly enable settings incompatible with app needs. No arbitrary shell execution in Forge. Export service/timer units and install/verify/status/rollback instructions.
- Gate: supported distro/systemd version matrix (propose Ubuntu LTS and enterprise Linux; confirm exact supported versions); systemd-analyze verify and calendar checks for trusted fixtures; isolated VM runtime tests for service lifecycle and timers, no production operations. Browser UI exposes all supported controls.

### M4 — product and integration (#6, #7, #12)
- Consistent desktop/mobile Studio; guided and advanced forms, editable service/site collections, contextual diagnostics, per-artifact copy/download and deterministic ZIP, safe optional local project persistence only after privacy review.
- Ensure UI and engine capability parity; accessible keyboard navigation, focus, labels, responsive layout and no placeholders or dead routes. Preview and export use same validated result. Error states block invalid export; native and target-host status never falsely marked passed.
- Gate: end-to-end Playwright tests across all three generators including invalid inputs, multi-artifact export, deep routes, mobile and keyboard flows. Documentation with working examples and compatibility/limitations.

### M5 — security and release readiness (#9)
- Threat model inputs, output injection, browser XSS, ZIP paths, secrets handling, dependency supply chain, resource exhaustion and static hosting. Trusted CI fixtures only; native/runtime tests isolated and never evaluate arbitrary end-user inputs.
- Pin tool versions/digests; document support policy, dependency review, reproducible artifact manifest, CSP, route allowlist, cache policy, privacy-minimized logs, HTTPS, rollback and operational ownership. Resolve license, domain, branding, privacy obligations.
- Gate: all required checks on exact integrated release head; native validators and trusted runtime smoke pass for all supported profiles; no unresolved release-blocking findings; reviewed test evidence, accessibility/product approval, deployment and rollback rehearsal in private staging. Version package and lockfile consistently to 1.0.0 only after acceptance. No tag, publication, DNS change or production deployment without explicit authorization.

## Definition of done

All three engines meet their documented supported scope, with typed model, safe deterministic serialization, structural validation, native CI evidence, trusted runtime smoke tests, positive/negative/injection tests, usable UI, export, examples and warnings. Browser generation is not native verification of a user's output; target-host validation stays not-run until performed by its operator. Final release checklist must link evidence by exact commit. No numerical maturity scores without measured criteria.

## Immediate work

M0 first: review #23 (including deferred runtime behavior), #24 (visual/accessibility and capability parity) and #25 (dependency and packaging). Preserve the independent draft branches and update their release framing after review. Then initiate Compose and systemd model design as separate issues/PRs; do not publish an Nginx-only release. Scope decisions and support matrix must be reviewed before implementation.
