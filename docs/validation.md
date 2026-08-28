# Validation record

This page records completed checks without treating unavailable hardware as a pass.

## 2026-08-29 serial selection fix 0.3.1

| Check | Result | Evidence |
| --- | --- | --- |
| macOS driver binding | Pass | WCH `1A86:55D3` appears as `/dev/cu.usbmodem5A7B0294941` through Apple's serial stack; no additional driver is required on this host |
| Dockyard32 live receive | Pass | Real VS Code Extension Host runtime opened the preferred callout path at 115200 8N1 and received 1,304 bytes in two seconds |
| Automatic selection | Pass | Physical USB callout ports sort ahead of Bluetooth/debug-console endpoints; all endpoints remain manually selectable |
| Unit/Core/conversion tests | Pass | 102 tests passed, including the updated physical USB port-priority regression |
| Source and packaged Extension Host | Pass | Source activation and final unpacked VSIX activation passed |
| VSIX inspection | Pass | `dockyard32-0.3.1-darwin-arm64.vsix` passed target, privacy, native-module, and archive checks across 4,333 entries |
| Python assistant | Pass | Version 2.1.1 auto-selects the physical USB port and displays firmware streams that omit CR/LF using bounded partial chunks |

## 2026-08-24 RTOS Preview 0.3.0

| Check | Result | Evidence |
| --- | --- | --- |
| Fresh dependency install | Pass | Existing `node_modules` was moved out of the repository; `pnpm install --frozen-lockfile` installed 474 packages with pnpm 11.19.0 |
| TypeScript and ESLint | Pass | Clean compile and zero lint warnings |
| Unit/Core/conversion tests | Pass | 102 tests passed, including RTOS detection/parser/capture and example-integrity tests |
| RTOS process safety | Pass | Fake processes cover successful detach, JSON followed by nonzero exit, missing detach, GDB timeout with SIGKILL fallback, server startup failure/timeout, cleanup, duplicate capture rejection, and stale-snapshot invalidation |
| Source Extension Host | Pass | Dockyard32 activated with the RTOS commands and `dockyard32.rtosView` contribution |
| F407 example build | Pass | Clean GNU Arm 14.3.1/Ninja build completed 13 steps and produced ELF/HEX; FLASH 9,788 B and RAM 34,912 B |
| VSIX inspection | Pass | `dockyard32-0.3.0-darwin-arm64.vsix` passed target, privacy, native-module, and archive checks across 4,333 entries |
| Unpacked release VSIX | Pass | The packaged extension and its pruned serial runtime activated in an Extension Host |
| Minimum VS Code 1.96 | CI gate | The fixed-version Extension Host job remains configured in `.github/workflows/macos-ci.yml`; it is not claimed as a new local pass here |
| F407 FreeRTOS live snapshot | Pending | No successful ST-LINK live capture was performed for this validation record |
| STM32F103 hardware | Pending | No F103 target was connected for this run |
| STM32G474 hardware | Pending | No G474 target was connected for this run |

The local check ran under Node.js 26.7.0 and therefore emitted the package's expected engine warning (`>=22 <25`). Release CI pins Node.js 22.20.0 from `.node-version`; functional checks still passed locally. This preview should use Node 22 for development and CI.

## 2026-08-15 Dockyard32 rename checks

| Check | Result | Evidence |
| --- | --- | --- |
| Product identity | Pass | Extension ID is `izjxxxx.dockyard32`; commands, settings, views, MCP server, assets, documentation, CI artifacts, and VSIX names use Dockyard32 |
| Legacy compatibility | Pass | Existing STM32 Workbench import metadata, workspace configuration, last-run records, and MCP workspace environment variables remain readable |
| Core/conversion tests | Pass | 82 tests, including three legacy-name compatibility checks |
| Extension and VSIX | Pass | Source and unpacked release VSIX both activated in a real Extension Host; 4,326 archive entries passed platform, privacy, native-module, and development-file checks |
| Keil AC5 project import | Pass | TFTLCD experiment imported 105 selected inputs into a 121-file standalone CMake tree; GNU Arm completed all 23 build steps and generated ELF, HEX, and BIN firmware |

## 2026-08-14 release-candidate checks

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript and ESLint | Pass | Clean compile and zero lint warnings |
| Core/conversion tests | Pass | 80 tests, including unsafe roots/symlinks, import previews, exact dependency copies, external dependencies, non-empty destinations, per-file options, and F1/F4/G4 profiles |
| VS Code Extension Host | Pass | Extension activation and all three contributed views registered in a real macOS Extension Host |
| VSIX inspection | Pass | Manifest target is `darwin-arm64`; only the universal Darwin serial module is present; foreign native modules, build sources, local paths, common secret formats, tests, local metadata, and pnpm internals are rejected |
| Unpacked release VSIX | Pass | The generated archive was extracted to a temporary directory and that packaged copy activated successfully in a real Extension Host, including serial backend loading |
| Minimum VS Code 1.96 | CI gate | Fixed-version integration step is configured; the local Microsoft CDN download was too slow to complete, so this row is not recorded as a local pass |
| Keil AC5 project import | Pass | TFTLCD AC5 project imported to native macOS CMake and built with GNU Arm with 0 errors and 0 warnings |
| Keil AC6 project export | Pass | TFTLCD exported and rebuilt with Keil MDK 5.42 / ARM Compiler 6.23: AXF and HEX created, 0 errors and 0 warnings |
| STM32F407 hardware | Pass | CMake build, ST-LINK SWD flash, verify, reset, and 115200 UART receive completed on STM32F407 hardware |
| STM32F103 hardware | Pending | No F103 target was connected for this run |
| STM32G474 hardware | Pending | No G474 target was connected for this run |

## Link-map comparison

For the TFTLCD GCC/ARMClang comparison:

- FLASH starts at `0x08000000` and is `1 MiB` in both configurations.
- RAM starts at `0x20000000` and is `128 KiB` in both configurations.
- CCMRAM starts at `0x10000000` and is `64 KiB` in the GNU configuration and is retained by the generated device/scatter model.
- The vector table starts at `0x08000000` in both maps.
- The configured stack is `0x800` bytes and heap is `0x200` bytes; MicroLIB may discard an unused heap region.

Function addresses and binary contents differ between GNU Arm and ARMClang. Matching memory regions and vector placement do not imply binary equivalence.
