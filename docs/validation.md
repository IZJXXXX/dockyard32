# Validation record

This page records completed checks without treating unavailable hardware as a pass.

## 2026-08-14 release-candidate checks

| Check | Result | Evidence |
| --- | --- | --- |
| TypeScript and ESLint | Pass | Clean compile and zero lint warnings |
| Core/conversion tests | Pass | 80 tests, including unsafe roots/symlinks, import previews, exact dependency copies, external dependencies, non-empty destinations, per-file options, and F1/F4/G4 profiles |
| VS Code Extension Host | Pass | Extension activation and all three contributed views registered in a real macOS Extension Host |
| VSIX inspection | Pass | Runtime dependencies and universal macOS serial binding present; sources, tests, local metadata, and pnpm internals absent |
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
