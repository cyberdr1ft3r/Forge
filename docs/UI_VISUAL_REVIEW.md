# Forge v0.1 visual review evidence

Reference: Figma file `utXHuHFSoeqTK22SEeQNjY`, approved A4 workspace node `9:2`.

The Playwright test `captures reproducible Forge visual review evidence at fixed viewports` produces five screenshots from the real browser application:

- `visual-landing-desktop.png`
- `visual-nginx-generated-desktop.png`
- `visual-nginx-multifile-desktop.png`
- `visual-validation-error-desktop.png`
- `visual-nginx-mobile.png`

GitHub Actions uploads them as the `forge-ui-review-<commit SHA>` artifact with a 14-day retention period. The desktop evidence uses a 1440×900 viewport, matching the A4 reference width. Tablet overflow is checked at 820×1180, and mobile evidence uses 390×844. Browser assertions fail on horizontal page overflow.

For clean full-page evidence, the capture helper temporarily hides the keyboard-only skip link and changes the sticky validation strip to normal flow. Their runtime behavior is unchanged and covered by interaction tests.

## Intentional deviations from A4

- A4 is the approved focused workspace direction, not a final landing-page design. The landing page reuses its dark Precision palette and compact navigation without claiming final Figma approval.
- The implementation grows vertically instead of clipping the configuration panel to A4's fixed 643-pixel study height. Inline help, conditional TLS fields, compatibility assumptions, validation errors and accessibility content remain readable.
- The unsupported security-response-header option shown in the exploration is omitted. Forge exposes only capabilities backed by the merged typed engine.
- Multiple returned artifacts use native selector buttons with primary/supporting labels. A4 illustrates one file only.
- Forge adds the target-host validation state and detailed prerequisites because the product must distinguish composition from deployment readiness.
- Tablet and mobile layouts stack the form and preview instead of preserving the desktop ratio.

These differences preserve the approved visual language while meeting the reviewed safety, artifact, validation and responsive requirements. Human owner review remains required; passing screenshots are evidence, not visual sign-off.
