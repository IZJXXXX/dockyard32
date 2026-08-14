# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and the project uses semantic versioning.

## [Unreleased]

## [0.1.1] - 2026-08-14

### Added

- Safe, selective Keil import and CMake-to-Keil export paths.
- Relative-path conversion reports and external-path redaction.
- Explicit MCU and multi-Target selection.
- Per-file `compile_commands.json` option preservation.
- Conversion safety tests and VS Code Extension Host integration tests.
- macOS GitHub Actions build, test, package, and VSIX inspection workflow.
- Open-source support matrix, troubleshooting, contribution, and security documentation.
- Selective copying of source files intentionally embedded with `#include` in legacy Keil projects.
- ARM Compiler 6 retarget compatibility for legacy `FILE __stdout` and no-semihosting `fputc` projects.
- Pre-import file/size/external-path preview and exact include-dependency copying without recursive include-directory copies.
- A Marketplace-compatible 256×256 PNG icon and strict empty-directory policy for both import and export.

### Changed

- Unknown devices no longer fall back to STM32F407.
- Import and export reject non-empty destinations; existing files are never overwritten.
- VSIX packaging uses a flattened, Darwin-only production dependency tree, declares `darwin-arm64`, and rejects non-macOS native modules.
- VSIX inspection scans packaged text for local user paths and common secret/token formats.
- Extension Host integration tests include the declared minimum VS Code 1.96 release.
- CI unpacks the final VSIX and activates that packaged copy in an Extension Host, including its pruned runtime dependencies.

## [0.1.0] - 2026-08-14

### Added

- STM32 project detection, CMake build, GCC diagnostics, ST-LINK programming, serial monitor, Build & Run, Agent API, stdio MCP, Project Files, and initial Keil import/export.
