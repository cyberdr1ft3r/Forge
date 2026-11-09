# Forge v0.1 UI and Nginx integration plan

Prepared from `main` at `cb4f4bd` before implementation. The approved A4 Figma node is `9:2` in file `utXHuHFSoeqTK22SEeQNjY`. PR #23 is open and unmerged, so traffic limiting is intentionally excluded.

## Intended implementation

1. Replace the single legacy workspace shell with two browser views: an honest public landing page and a directly addressable generator workspace at `/generators/nginx`, `/generators/compose`, and `/generators/systemd`.
2. Translate the approved A4 visual direction into the existing dependency-light HTML/CSS/TypeScript stack: compact top navigation, grouped configuration controls, a responsive 65/35 workspace, scrollable file preview, expansion mode, and a persistent validation strip.
3. Connect the Nginx workspace directly to `composeNginxCapabilities()` for HTTP/HTTPS reverse proxy, WebSocket proxy, static site, SPA fallback, and the `full-config`/`site-fragment` output profiles. Keep selections shaped as typed capability inputs so additional merged shelves can be exposed without replacing the workspace architecture.
4. Preserve the existing versioned generator lifecycle for Docker Compose and systemd by continuing to call their registered `tryGenerate` outcomes without changing their schemas, normalization, generation, or validation behavior.
5. Render every returned artifact, mark primary/supporting roles, support per-artifact copy/download, and create a local standards-compliant ZIP export when a result contains multiple artifacts.
6. Show input, static, native, and target-host states exactly as returned. Surface field-specific diagnostics, prerequisites, and operator cautions without deployment or server-connection actions.
7. Add browser coverage for routing, switching, validation, composition, artifact selection, copy/download/ZIP, responsive layout, and keyboard/accessibility basics while retaining all engine regression tests.

## Compatibility and implementation risks

- **Legacy Nginx output changes only in the new Nginx workspace.** The public legacy `generateNginx` adapter remains unchanged for API compatibility; browser Nginx output will intentionally come from the composition engine and may use `nginx.conf`, `site.conf`, and `http-shared.conf` rather than the historic domain filename.
- **Compose and systemd must remain contract-identical.** Their generator definitions and legacy exports will not be changed. UI input conversion must preserve explicit boolean/number semantics and must display native validation as unavailable.
- **History API routes require server fallback.** `server.js` must serve `index.html` for known generator routes while continuing to reject traversal and return 404 for unknown assets/routes.
- **Supporting artifacts are mandatory.** Site fragments for WebSocket or static-site workflows can require `http-shared.conf`; export and preview logic must never silently drop it.
- **ZIP generation is browser-local.** A small internal ZIP writer will use stored entries and CRC-32 to avoid a runtime service or credential/telemetry boundary. Tests must verify filenames and signatures.
- **Clipboard and download APIs vary by browser.** Controls need visible fallback errors and should not imply success when an API rejects.
- **Validation terminology is safety-critical.** CI native-fixture evidence does not prove a user's generated configuration. The UI must never translate `unavailable` or `not-run` into passed.
- **The approved Figma node is a focused workspace, not a final landing design.** The landing view will reuse its visual DNA while remaining deliberately conservative and will be called an implementation direction, not a final Figma-approved screen.
- **No PR #23 code or traffic-limiting UI.** Capability discovery may see only definitions merged into this branch; the product surface will expose the milestone's required workflows and will not hard-code or advertise the unmerged shelf.
- **No arbitrary capability editor.** The UI will construct allow-listed typed capability selections only; generated content is inserted with `textContent` and never interpreted as HTML.

## Verification plan

- `npm run typecheck`, `npm run build`, syntax checks, `npm test`, browser tests, dependency audit, and HTTP smoke tests.
- Desktop and mobile browser screenshots compared against the A4 screenshot, including the 65/35 relationship, compact navigation, focus treatment, scrolling, and validation strip.
- Exact-head GitHub Actions after opening a draft PR. No merge, deployment, Nginx reload, Docker action, systemd action, or release publication.
