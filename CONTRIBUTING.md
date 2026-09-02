# Contributing

Thank you for contributing to Paseo GitHub Workbench.

## Before opening a pull request

- Open an issue first for a substantial feature or a behavior change.
- Keep each pull request focused on one user-visible outcome.
- Do not include access tokens, private repository metadata, or local paths in
  commits, screenshots, logs, or issue descriptions.
- For UI changes, include screenshots or a short recording and state the Paseo
  platforms you verified.

## Local checks

Use Bun and run all checks before requesting review:

    bun install --frozen-lockfile
    bun run check
    bun run typecheck
    bun test

## Plugin compatibility

The plugin is loaded by Paseo as trusted code. Keep server-only code in
files ending in .server.ts, client UI in .client.tsx, and RPC contracts in
.shared.ts. When changing the supported Paseo version, regenerate
paseo-plugin.d.ts with the matching Paseo CLI and document the compatibility
change.

## Pull request expectations

Describe the problem, the approach, and verification performed. Link related
issues where applicable. Maintain backwards-compatible behavior unless the
pull request explicitly documents a breaking change.
