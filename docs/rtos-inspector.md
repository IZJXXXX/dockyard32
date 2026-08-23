# Dockyard32 RTOS Inspector

Dockyard32 0.3.0 provides a CLion-style runtime view for FreeRTOS as an **Apple Silicon Preview**. It automatically detects supported kernels without prompting bare-metal projects. Static detection does not need hardware; a live task/object snapshot does.

## Automatic detection

Auto mode combines bounded, read-only evidence from:

- STM32CubeMX `.ioc` middleware settings.
- FreeRTOS, CMSIS-RTOS, ThreadX, and Zephyr headers and kernel sources.
- CMake references and known RTOS API calls.
- Post-build ELF symbols inspected with `arm-none-eabi-nm`.

ELF confirmation takes precedence over weaker source-layout inference. **Settings → Dockyard32 → RTOS → Mode** can disable inspection or override an unusual generated layout. ThreadX and Zephyr remain **detection only** in 0.3.0; their live task readers are not implemented.

## FreeRTOS live snapshot

After building a debug ELF, open **Dockyard32 RTOS** and select **Capture Snapshot**. Dockyard32 then:

1. Starts ST-LINK GDB Server in attach mode with a bounded startup time.
2. Attaches GNU Arm GDB without downloading firmware.
3. Traverses standard FreeRTOS task lists, TCB fields, and the queue registry.
4. Emits a structured snapshot only after GDB confirms a successful detach.
5. Terminates and awaits GDB and the temporary GDB Server process.

The **Tasks** tab reports task name, state, priority, stack usage when available, and runtime share when enabled. The **Objects** tab reports registered queues, semaphores, mutexes, fill level, owner, and waiter count. The **Relationships** tab resolves edges such as `Consumer waits to receive → SensorQueue` and `MutexWaiter waits for mutex → SharedStateMutex (owner: ResourceOwner)`.

`xPendingReadyList` entries are shown as `pending-ready`, not blocked. Dockyard32 inspects a task's event-list container to distinguish a truly suspended task from an indefinite block; if debug information cannot support that distinction, it reports `unknown` rather than guessing.

## Safety behavior

- Only one capture can run at a time, including direct Core calls.
- Both GDB Server startup and total GDB capture have explicit timeouts.
- Timeout cleanup sends SIGTERM, waits, then uses SIGKILL as a fallback and waits again.
- A capture is successful only when GDB exits with code 0, valid RTOS JSON is received, and the detach-success marker is present.
- JSON output does not hide a later detach or process-exit failure.
- If detach is unconfirmed, `targetResumed` is false and the UI warns that the target may still be paused. Use **Reset Target** or reconnect a debugger before relying on target execution.
- Changing workspace, kernel, or ELF clears the previous snapshot; late results from an older capture are discarded.

Live inspection briefly halts the MCU and may disturb timing-sensitive peripherals, motor control, USB, networking, or watchdog behavior. Capture is therefore always an explicit user action.

## Firmware requirements

- An ELF with debug information and standard FreeRTOS types/symbols.
- `configUSE_TRACE_FACILITY=1`.
- `configQUEUE_REGISTRY_SIZE>0` and `vQueueAddToRegistry()` for named objects.
- `configRECORD_STACK_HIGH_ADDRESS=1` for accurate stack bounds.
- `configMAX_TASK_NAME_LEN>0` for task names.
- Optional runtime share requires `configGENERATE_RUN_TIME_STATS` and valid counters.

Highly optimized or stripped builds, custom kernel forks, renamed globals, changed TCB/list layouts, and incomplete debug information can reduce accuracy or produce `unknown` fields.

## Try the example

Open [the F407 FreeRTOS relationship demo](../examples/F407_FreeRTOS_Relationship_Demo/README.md). It builds without the full STM32CubeF4 package and creates five tasks plus a queue, mutex, binary semaphore, and counting semaphore for relationship inspection.
