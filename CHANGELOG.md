# Changelog

All notable changes to this project are documented here. The format follows Keep a Changelog, and the project uses semantic versioning.

## [Unreleased]

## [0.3.1] - 2026-08-29

### Fixed

- Prefer physical `/dev/cu.*` USB serial devices over macOS Bluetooth and debug-console endpoints during automatic selection, while keeping every valid port available for manual selection.
- Verified the WCH `1A86:55D3` USB serial path with the real VS Code Extension Host runtime at 115200 8N1.

## [0.3.0] - 2026-08-24

Apple Silicon Preview. This release is not declared stable.

### Added

- Automatic FreeRTOS, ThreadX, and Zephyr project detection with ELF-symbol confirmation.
- FreeRTOS live task, stack, queue, semaphore, mutex ownership, and wait-relationship snapshots through ST-LINK GDB Server and GNU Arm GDB.
- A dedicated Dockyard32 RTOS panel with Tasks, Objects, and Relationships views.
- A minimal STM32F407ZGT6 FreeRTOS relationship example with five tasks and registered kernel objects.
- Fake GDB/GDB Server regression coverage for success, detach failure, nonzero exit, timeouts, startup failure, process cleanup, concurrent capture rejection, and stale-snapshot invalidation.

### Security

- Bounded GDB Server startup and capture time, followed by awaited SIGTERM and SIGKILL fallback cleanup.
- Capture succeeds only after valid RTOS JSON, a zero GDB exit status, and confirmed detach.
- Concurrent captures are rejected, and project/kernel/ELF changes invalidate old snapshots.

### Changed

- FreeRTOS pending-ready tasks are no longer reported as blocked; ambiguous suspended/indefinitely-blocked tasks fall back to `unknown` when the event-list container cannot disambiguate them.
- ThreadX and Zephyr are explicitly detection-only in this preview.
- Renamed the extension, Marketplace identity, commands, settings, MCP server, project metadata, and release artifacts from STM32 Workbench to Dockyard32.
- Added compatibility reads for existing STM32 Workbench workspace configuration and imported-project metadata.

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
