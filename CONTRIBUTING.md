# Contributing

Thank you for helping improve Dockyard32.

## Before opening a change

- Search existing issues and describe the STM32 family, exact MCU, host, project format, compiler, and tool versions.
- Do not attach proprietary firmware, licensed device-pack content, private keys, absolute home paths, or customer source without permission.
- Keep Core logic independent from VS Code UI and Webview DOM.
- Treat conversion as untrusted file processing: use bounded traversal, reject broad roots, avoid symlink following, and keep reports path-safe.

## Development setup

1. Install Node.js and pnpm versions declared in `.node-version` and `package.json`.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm run check:unit` while developing.
4. Run `pnpm run test:integration` before submitting.
5. Run `pnpm run package:vsix && pnpm run check:vsix` for packaging changes.

## Pull requests

- Add tests for bug fixes and conversion rules.
- Keep generated `out/`, VSIX, `.DS_Store`, logs, and hardware artifacts out of Git.
- Update the support matrix and changelog when behavior changes.
- Do not claim hardware or Keil validation unless the exact device/compiler run was completed and recorded.

Hardware-only checks are allowed to be marked pending in pull requests, but Core, lint, integration, and packaging checks must pass.
