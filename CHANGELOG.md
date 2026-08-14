# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and the project uses semantic versioning.

## [Unreleased]

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
- Export to non-empty directories is rejected unless the graphical user explicitly confirms it.
- VSIX packaging uses a flattened production dependency tree so pnpm symlinks are not lost.

## [0.1.0] - 2026-08-14

### Added

- STM32 project detection, CMake build, GCC diagnostics, ST-LINK programming, serial monitor, Build & Run, Agent API, stdio MCP, Project Files, and initial Keil import/export.
