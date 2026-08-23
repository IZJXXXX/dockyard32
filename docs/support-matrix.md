# Support matrix

## Hosts and tools

| Area | Supported | Notes |
| --- | --- | --- |
| macOS Apple Silicon | Yes | Only published target: `darwin-arm64` |
| macOS Intel | No package | The serial binary is universal, but no `darwin-x64` VSIX is published |
| Windows extension host | Not currently targeted | Windows is used for Keil export validation |
| Linux extension host | Not currently targeted | Core CMake logic is portable but unverified |
| STM32CubeCLT | Yes | Automatically discovered in common locations |
| STM32CubeProgrammer CLI | Yes | GUI automation is never used |
| ST-LINK/SWD | Yes | Single-probe workflows are supported |
| J-Link/CMSIS-DAP | No | Not implemented |
| GNU Arm GDB + ST-LINK GDB Server | Preview | Required only for live FreeRTOS snapshots; source/ELF detection works without hardware |

## Devices

| Family | Detection | Build flags | Keil import/export | Hardware regression |
| --- | --- | --- | --- | --- |
| STM32F1 | Yes | Cortex-M3, no FPU | Best effort | F103 pending |
| STM32F4 | Yes | Cortex-M4F | Best effort | F407ZGT6 |
| STM32G4 | Yes | Cortex-M4F | Best effort | G474 pending |

The family profiles cover common density codes and conservative RAM/CCMRAM defaults. The exact linker script or Keil memory configuration takes precedence over defaults. An unknown MCU is never treated as an F407.

## RTOS inspection

| Kernel/workflow | Status | Notes |
| --- | --- | --- |
| Bare metal | Supported | Stays inactive without prompts |
| FreeRTOS source/config detection | Preview | `.ioc`, headers, sources, CMake references, and known APIs |
| FreeRTOS ELF confirmation | Preview | GNU `nm` symbols take precedence over weaker source evidence |
| FreeRTOS tasks and states | Preview | Includes ready, pending-ready, blocked, suspended, deleted, and conservative unknown states |
| Queue/semaphore/mutex relationships | Preview | Requires registered kernel objects and debug type information |
| ThreadX | Detection only | Live tasks/objects are not read in 0.3.0 |
| Zephyr | Detection only | Live threads/objects are not read in 0.3.0 |

Live capture briefly halts the target and therefore requires ST-LINK, ST-LINK GDB Server, GNU Arm GDB, and a debuggable ELF. Detection and static project inspection do not require hardware. See [RTOS Inspector](rtos-inspector.md).

## Project formats

| Format | Capability | Important limits |
| --- | --- | --- |
| CubeMX `.ioc` | Detect MCU/family | No embedded CubeMX pin editor |
| CMake | Configure/build/diagnostics | Project must be compatible with command-line CMake |
| `compile_commands.json` | Keil AC6 export input | Must represent the intended target/configuration |
| Keil `.uvprojx` AC5 | Import | Proprietary source and `.lib` files may need replacement |
| Keil `.uvprojx` AC6 | Import | ARMClang-only syntax may need adaptation |
| Keil AC6 output | Export | Generated scatter/startup must be reviewed against the GNU map |

The current Windows regression uses Keil MDK 5.42 with ARM Compiler 6.23 and produces AXF/HEX with 0 errors and 0 warnings for the F407 TFTLCD fixture. See the [validation record](validation.md). This is a regression point, not a promise that every third-party Keil project converts without review.

## Conversion equivalence

Dockyard32 preserves the information it can model: selected Target, device, sources, include paths, defines, common and per-file compile controls, memory regions, entry point, stack/heap sizes, detected custom sections, startup choice, and library references.

It does not promise bit-identical output, cycle-identical code, or identical memory layout across GCC and ARMClang. Production users must compare map files, vector/entry addresses, bootloader offsets, memory-region utilization, and hardware behavior.
