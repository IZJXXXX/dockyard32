# Troubleshooting

## Workbench views say no provider is registered

1. Install the newest VSIX.
2. Run **Developer: Reload Window** from the Command Palette.
3. Open **Help → Toggle Developer Tools** and inspect extension-host errors.
4. If a runtime module is missing, attach the Extension Host log and the output of the VSIX integrity check to an issue.

## CMake, Ninja, GNU Arm, or Programmer is not found

Install STM32CubeCLT, STM32CubeProgrammer, or the STM32Cube VS Code tool bundles. Then use **Settings → STM32 Workbench → Tools** to select an executable if automatic discovery cannot find it.

## Keil import is rejected as unsafe

Choose the actual project root, not `/`, `/Users`, or your home folder. The `.uvprojx` must be inside that root. External include directories are supported and are copied into a redacted `External` subtree.

## Export destination is not empty

Choose an empty folder. The graphical command can continue only after a modal overwrite confirmation. Core/API callers must explicitly set the non-empty override; it is disabled by default.

## MCU selection is requested

Enter the exact supported F1, F4, or G4 part, for example `STM32F103C8T6`, `STM32F407ZGT6`, or `STM32G474VET6`. The converter intentionally does not guess F407 when evidence is missing.

## Keil build warns or links differently

Read `stm32-workbench-export.json`, inspect per-file options, and compare GNU and Keil map files. Pay special attention to startup, scatter regions, stack/heap, floating-point ABI, precompiled libraries, custom sections, and Bootloader offsets.

## ST-LINK is not detected

- Disconnect ST-LINK from virtual machines and other programmer applications.
- Reconnect the USB device and refresh Workbench status.
- Confirm STM32CubeProgrammer CLI can enumerate the probe.
- Only one connected probe is accepted by automatic programming.

## Serial cannot connect

- Prefer `/dev/cu.*` on macOS.
- Close other serial monitors and virtual machines that own the device.
- Confirm baud rate, data bits, parity, and stop bits.
- Reopen the serial view after reconnecting the USB adapter.
