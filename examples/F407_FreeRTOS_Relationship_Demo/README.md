# F407 FreeRTOS Relationship Demo

This deliberately small STM32F407ZGT6 firmware demonstrates the live RTOS snapshot in Dockyard32. It creates five named tasks and registers one queue, one mutex, one binary semaphore, and one counting semaphore so task/object relationships are visible without importing the full STM32CubeF4 tree.

## Hardware

- STM32F407ZGT6 board
- ST-LINK with SWD
- SWDIO → PA13, SWCLK → PA14, GND → GND, and optionally NRST → NRST
- Power the target according to the board documentation. Avoid connecting competing power supplies.

The example does not require a UART connection. A live snapshot does require a connected ST-LINK because Dockyard32 briefly halts the running target through GDB, reads FreeRTOS kernel data, detaches, and resumes it.

## What the snapshot should show

| Task | Purpose | Expected relationship |
| --- | --- | --- |
| `Producer` | Sends samples | Sends to `SensorQueue` |
| `Consumer` | Receives samples | Waits on `SensorQueue` |
| `ResourceOwner` | Holds the mutex | Owns `SharedStateMutex`, waits on `OwnerRelease` |
| `MutexWaiter` | Demonstrates contention | Waits on `SharedStateMutex` |
| `Logger` | Waits for log work | Waits on `LogSemaphore` |

`ResourceOwner` intentionally blocks while holding a mutex to make the holder/waiter relationship stable for inspection. This is a demonstration pattern, not recommended application design.

## Build

1. Install GNU Arm Embedded, CMake, and Ninja, or install the equivalent STM32Cube tool bundle.
2. Open this directory in VS Code.
3. Open Dockyard32 and select **Build Project**.

The checked-in toolchain derives `arm-none-eabi-objcopy` and `arm-none-eabi-size` from the selected compiler directory, so those tools do not need separate PATH configuration.

For a reproducible command-line check used by maintainers:

```sh
cmake --preset Debug
cmake --build --preset Debug
```

## Flash and capture

1. Connect ST-LINK and select **Build & Run** (or **Flash Firmware**) in Dockyard32.
2. Open **Dockyard32 RTOS** from the Dockyard32 sidebar.
3. Confirm that FreeRTOS and the generated ELF are detected.
4. Select **Capture Snapshot**.
5. Inspect the **Tasks**, **Objects**, and **Relationships** tabs.

ThreadX and Zephyr are detection-only in Dockyard32 0.3.0; this example uses FreeRTOS V10.4.6.

## Third-party code

Only the CMSIS Core/device files and FreeRTOS Kernel files needed by this F407 build are vendored. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the license files under `ThirdParty/`.
