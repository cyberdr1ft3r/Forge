# Forge agent instructions

These instructions apply to all AI coding agents working in this repository.

## Priorities
1. Correctness and safely validated infrastructure output.
2. Deterministic, testable configuration generation.
3. Understandable UI and explicit warnings.
4. Minimal change scope and maintainability.

## Workflow
- Start from the latest `main`; work on a dedicated issue branch.
- Read the issue and affected generator before editing.
- Write down the intended behavior, risk, and native-tool assumptions.
- Keep generators behind the versioned `GeneratorDefinition` contract. Preserve the validate → normalize → generate → static validate → export lifecycle and register new generators through `GeneratorRegistry`.
- Keep browser/UI concerns out of `src/core` and individual generators. Generators must remain deterministic and independently testable.
- Model future multi-file output as artifacts; do not add ad hoc secondary return shapes or executable template/plugin code.
- Add positive, negative, and injection-resistance tests with each generator change.
- Run `npm run typecheck`, `npm test`, and syntax checks; report results accurately, never fabricate native validation.
- Open a PR with reproduction, test evidence, limitations, and rollback guidance.
- Do not merge without review. Never modify unrelated code or deploy without explicit authorization.

## Security
- Treat configuration inputs and imported files as untrusted.
- Do not execute submitted configurations or shell commands.
- Do not expose secrets in fixtures, logs, generated files or commits.
- Generation does not imply native validation. Label each validation tier accurately.
- Native validation status may be `passed` only when the declared native tool actually executed successfully. Browser generation currently reports it as `unavailable`.
- Never execute deployment, restart or reload on a production host by default.
- Preserve changes that may have been made by other contributors; never force-push main.
