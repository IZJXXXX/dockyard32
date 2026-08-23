import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  RtosCaptureOptions,
  RtosDebugTools,
  RtosKernelObject,
  RtosObjectType,
  RtosRelation,
  RtosRelationKind,
  RtosSnapshot,
  RtosTask,
  RtosTaskState,
} from '../types/rtos';

const SNAPSHOT_MARKER = 'DOCKYARD32_RTOS_JSON:';
const DETACH_MARKER = 'DOCKYARD32_RTOS_DETACHED';
const MAX_TOOL_SCAN_ENTRIES = 30_000;
const MAX_TOOL_SCAN_DEPTH = 9;
const DEFAULT_SERVER_STARTUP_TIMEOUT_MS = 8_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 20_000;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;
let captureInProgress = false;

interface ManagedProcessResult {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: NodeJS.ErrnoException;
  readonly timedOut: boolean;
}

export interface DiscoverRtosDebugToolsOptions {
  readonly configuredGdb?: string;
  readonly configuredGdbServer?: string;
  readonly armGccExecutable?: string;
  readonly programmerExecutable?: string;
  readonly searchRoots?: readonly string[];
}

export async function discoverRtosDebugTools(
  options: DiscoverRtosDebugToolsOptions = {},
): Promise<RtosDebugTools> {
  const gdbCandidates = [
    options.configuredGdb,
    options.armGccExecutable === undefined
      ? undefined
      : path.join(path.dirname(options.armGccExecutable), 'arm-none-eabi-gdb'),
  ];
  const gdbServerCandidates = [options.configuredGdbServer];
  let gdbExecutable = await firstExecutable(gdbCandidates);
  let gdbServerExecutable = await firstExecutable(gdbServerCandidates);
  if (gdbExecutable === undefined || gdbServerExecutable === undefined) {
    const discovered = await scanForDebugTools(
      options.searchRoots ?? defaultDebugToolRoots(),
    );
    gdbExecutable ??= discovered.gdbExecutable;
    gdbServerExecutable ??= discovered.gdbServerExecutable;
  }
  return {
    gdbExecutable,
    gdbServerExecutable,
    programmerExecutable: options.programmerExecutable,
  };
}

export async function captureFreeRtosSnapshot(
  options: RtosCaptureOptions,
): Promise<RtosSnapshot> {
  if (captureInProgress) {
    return snapshotFailure(
      Date.now(),
      'Another RTOS capture is already in progress',
      undefined,
      true,
    );
  }
  captureInProgress = true;
  try {
    return await captureFreeRtosSnapshotUnsafe(options);
  } catch (error) {
    return snapshotFailure(
      Date.now(),
      error instanceof Error ? error.message : String(error),
      undefined,
      false,
    );
  } finally {
    captureInProgress = false;
  }
}

async function captureFreeRtosSnapshotUnsafe(
  options: RtosCaptureOptions,
): Promise<RtosSnapshot> {
  const capturedAt = Date.now();
  if (options.gdbExecutable === undefined) {
    return snapshotFailure(capturedAt, 'GNU Arm GDB was not found', undefined, true);
  }
  if (options.gdbServerExecutable === undefined) {
    return snapshotFailure(capturedAt, 'ST-LINK GDB server was not found', undefined, true);
  }
  if (options.programmerExecutable === undefined) {
    return snapshotFailure(capturedAt, 'STM32CubeProgrammer CLI was not found', undefined, true);
  }
  try {
    if (!(await fs.stat(options.elfPath)).isFile()) {
      return snapshotFailure(capturedAt, 'ELF firmware was not found', undefined, true);
    }
  } catch {
    return snapshotFailure(capturedAt, 'ELF firmware was not found', undefined, true);
  }

  const port = await availableTcpPort();
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'dockyard32-rtos-'),
  );
  const pythonScript = path.join(temporaryDirectory, 'freertos_snapshot.py');
  await fs.writeFile(pythonScript, createFreeRtosGdbPython(), 'utf8');
  const serverArgs = [
    '--attach',
    '--persistent',
    '--swd',
    '--port-number',
    String(port),
    '--stm32cubeprogrammer-path',
    path.dirname(options.programmerExecutable),
  ];
  if (options.probeSerialNumber !== undefined) {
    serverArgs.push('--serial-number', options.probeSerialNumber);
  }

  const server = spawn(options.gdbServerExecutable, serverArgs, {
    shell: false,
    env: process.env,
  });
  let serverOutput = '';
  const appendServerOutput = (chunk: Buffer): void => {
    const text = chunk.toString();
    serverOutput = trimOutput(`${serverOutput}${text}`);
    options.onOutput?.(text);
  };
  server.stdout.on('data', appendServerOutput);
  server.stderr.on('data', appendServerOutput);

  try {
    const started = await waitForServerStartup(
      server,
      () => serverOutput,
      options.serverStartupTimeoutMs ?? DEFAULT_SERVER_STARTUP_TIMEOUT_MS,
    );
    if (!started.success) {
      return snapshotFailure(
        capturedAt,
        started.error ?? 'ST-LINK GDB server did not start',
        serverOutput,
        true,
      );
    }
    const result = await runManagedProcess(
      options.gdbExecutable,
      [
        '--quiet',
        '--nx',
        '--batch',
        options.elfPath,
        '-ex',
        'set pagination off',
        '-ex',
        'set confirm off',
        '-ex',
        `target extended-remote localhost:${port}`,
        '-ex',
        `source ${pythonScript}`,
        '-ex',
        'dockyard32-freertos-snapshot',
        '-ex',
        'dockyard32-detach',
      ],
      {
        cwd: path.dirname(options.elfPath),
        onOutput: (event) => options.onOutput?.(event.text),
        timeoutMs: options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
        terminateGraceMs: options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const detachSucceeded = output.includes(DETACH_MARKER);
    const snapshot = parseRtosSnapshotOutput(
      output,
      capturedAt,
      detachSucceeded,
    );
    if (
      result.exitCode === 0 &&
      result.timedOut === false &&
      detachSucceeded &&
      snapshot?.success === true
    ) {
      return snapshot;
    }
    const error = result.timedOut
      ? `GNU Arm GDB capture timed out after ${options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS} ms`
      : result.spawnError?.message
        ?? (result.exitCode !== undefined && result.exitCode !== 0
          ? `GNU Arm GDB exited with code ${result.exitCode}`
          : !detachSucceeded
            ? 'GDB did not confirm a successful detach; the target may still be paused'
            : snapshot?.error
              ?? lastMeaningfulLine(output)
              ?? 'FreeRTOS data was not returned by GDB');
    return snapshotFailure(
      capturedAt,
      error,
      output,
      detachSucceeded,
    );
  } finally {
    await terminateChild(
      server,
      options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    );
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function parseRtosSnapshotOutput(
  output: string,
  capturedAt = Date.now(),
  targetResumed = false,
): RtosSnapshot | undefined {
  const markerIndex = output.lastIndexOf(SNAPSHOT_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }
  const jsonLine = output
    .slice(markerIndex + SNAPSHOT_MARKER.length)
    .split(/\r?\n/u)[0]
    ?.trim();
  if (jsonLine === undefined || jsonLine.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  if (typeof parsed.error === 'string') {
    return snapshotFailure(capturedAt, parsed.error, undefined, targetResumed);
  }
  if (!Array.isArray(parsed.tasks)) {
    return undefined;
  }
  const rawTasks = parsed.tasks;
  const tasks = rawTasks.map(parseTask).filter((task): task is RtosTask => task !== undefined);
  const rawObjects = Array.isArray(parsed.objects) ? parsed.objects : [];
  const objects = rawObjects
    .map(parseKernelObject)
    .filter((object): object is RtosKernelObject => object !== undefined);
  const rawRelations = Array.isArray(parsed.relations) ? parsed.relations : [];
  const relations = rawRelations
    .map(parseRelation)
    .filter((relation): relation is RtosRelation => relation !== undefined);
  const currentTaskAddress = finiteNumber(parsed.currentTaskAddress);
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    success: true,
    kernel: 'freertos',
    capturedAt,
    tasks,
    objects,
    relations,
    currentTaskAddress,
    warnings,
    targetResumed,
  };
}

async function scanForDebugTools(
  roots: readonly string[],
): Promise<Pick<RtosDebugTools, 'gdbExecutable' | 'gdbServerExecutable'>> {
  let visited = 0;
  let gdbExecutable: string | undefined;
  let gdbServerExecutable: string | undefined;

  async function visit(directory: string, depth: number): Promise<void> {
    if (
      depth > MAX_TOOL_SCAN_DEPTH ||
      visited >= MAX_TOOL_SCAN_ENTRIES ||
      (gdbExecutable !== undefined && gdbServerExecutable !== undefined)
    ) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => right.name.localeCompare(left.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    }));
    for (const entry of entries) {
      visited += 1;
      if (entry.isSymbolicLink()) {
        continue;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
      } else if (entry.isFile() && entry.name === 'arm-none-eabi-gdb' && gdbExecutable === undefined) {
        if (await isExecutable(candidate)) {
          gdbExecutable = candidate;
        }
      } else if (entry.isFile() && entry.name === 'ST-LINK_gdbserver' && gdbServerExecutable === undefined) {
        if (await isExecutable(candidate)) {
          gdbServerExecutable = candidate;
        }
      }
    }
  }

  for (const root of roots) {
    await visit(root, 0);
  }
  return { gdbExecutable, gdbServerExecutable };
}

function defaultDebugToolRoots(): string[] {
  return [
    path.join(os.homedir(), 'Library', 'Application Support', 'stm32cube', 'bundles'),
    '/Applications/STMicroelectronics',
    '/Applications/STM32CubeCLT',
  ];
}

async function firstExecutable(
  candidates: readonly (string | undefined)[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (candidate !== undefined && await isExecutable(candidate)) {
      return path.resolve(candidate);
    }
  }
  return undefined;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function availableTcpPort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null
        ? address.port
        : undefined;
      server.close((error) => {
        if (error !== undefined) {
          rejectPromise(error);
        } else if (port === undefined) {
          rejectPromise(new Error('Unable to allocate a GDB server port'));
        } else {
          resolvePromise(port);
        }
      });
    });
  });
}

function runManagedProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly terminateGraceMs: number;
    readonly onOutput?: (event: {
      readonly stream: 'stdout' | 'stderr';
      readonly text: string;
    }) => void;
  },
): Promise<ManagedProcessResult> {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: process.env,
      shell: false,
    });
    const finish = (result: Omit<ManagedProcessResult, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ ...result, stdout, stderr, timedOut });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = trimOutput(`${stdout}${text}`);
      options.onOutput?.({ stream: 'stdout', text });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = trimOutput(`${stderr}${text}`);
      options.onOutput?.({ stream: 'stderr', text });
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({ spawnError: error });
    });
    child.once('close', (exitCode) => {
      finish({ exitCode: exitCode ?? undefined });
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateChild(child, options.terminateGraceMs).then(() => {
        finish({ exitCode: child.exitCode ?? undefined });
      });
    }, Math.max(1, options.timeoutMs));
  });
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
): Promise<void> {
  if (processEnded(child)) {
    return;
  }
  child.kill('SIGTERM');
  if (await waitForExit(child, graceMs)) {
    return;
  }
  child.kill('SIGKILL');
  await waitForExit(child, graceMs);
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (processEnded(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off('close', onClose);
      resolvePromise(exited);
    };
    const onClose = (): void => finish(true);
    child.once('close', onClose);
    const timeout = setTimeout(
      () => finish(processEnded(child)),
      Math.max(1, timeoutMs),
    );
    if (processEnded(child)) {
      finish(true);
    }
  });
}

function processEnded(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForServerStartup(
  server: ChildProcessWithoutNullStreams,
  output: () => string,
  timeoutMs: number,
): Promise<{ readonly success: boolean; readonly error?: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: { readonly success: boolean; readonly error?: string }): void => {
      if (!settled) {
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        resolvePromise(result);
      }
    };
    const poll = setInterval(() => {
      if (/waiting for.*connection|listening.*port|gdb server.*started/iu.test(output())) {
        finish({ success: true });
      }
    }, 50);
    const timeout = setTimeout(() => finish({
      success: false,
      error: `ST-LINK GDB server startup timed out after ${timeoutMs} ms`,
    }), Math.max(1, timeoutMs));
    server.once('error', (error) => finish({ success: false, error: error.message }));
    server.once('exit', (code) => finish({
      success: false,
      error: lastMeaningfulLine(output()) ?? `ST-LINK GDB server exited with ${code ?? 'unknown code'}`,
    }));
  });
}

function parseTask(value: unknown): RtosTask | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = finiteNumber(value.id);
  const address = finiteNumber(value.address);
  const priority = finiteNumber(value.priority);
  if (id === undefined || address === undefined || priority === undefined) {
    return undefined;
  }
  const state = isTaskState(value.state) ? value.state : 'unknown';
  return {
    id,
    address,
    name: typeof value.name === 'string' && value.name.length > 0
      ? value.name
      : `Task ${id}`,
    state,
    priority,
    basePriority: finiteNumber(value.basePriority),
    stackPointer: finiteNumber(value.stackPointer),
    stackBase: finiteNumber(value.stackBase),
    stackEnd: finiteNumber(value.stackEnd),
    stackFreeBytes: finiteNumber(value.stackFreeBytes),
    stackTotalBytes: finiteNumber(value.stackTotalBytes),
    stackUsedPercent: finiteNumber(value.stackUsedPercent),
    runtimeCounter: finiteNumber(value.runtimeCounter),
    runtimePercent: finiteNumber(value.runtimePercent),
  };
}

function parseKernelObject(value: unknown): RtosKernelObject | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const address = finiteNumber(value.address);
  const messagesWaiting = finiteNumber(value.messagesWaiting);
  const length = finiteNumber(value.length);
  const itemSize = finiteNumber(value.itemSize);
  if (
    address === undefined ||
    messagesWaiting === undefined ||
    length === undefined ||
    itemSize === undefined
  ) {
    return undefined;
  }
  return {
    address,
    name: typeof value.name === 'string' && value.name.length > 0
      ? value.name
      : `Object 0x${address.toString(16)}`,
    type: isObjectType(value.type) ? value.type : 'unknown',
    messagesWaiting,
    length,
    itemSize,
    holderTaskAddress: finiteNumber(value.holderTaskAddress),
    waitingToSendTaskAddresses: numberArray(value.waitingToSendTaskAddresses),
    waitingToReceiveTaskAddresses: numberArray(value.waitingToReceiveTaskAddresses),
  };
}

function parseRelation(value: unknown): RtosRelation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const taskAddress = finiteNumber(value.taskAddress);
  const objectAddress = finiteNumber(value.objectAddress);
  if (
    taskAddress === undefined ||
    objectAddress === undefined ||
    !isRelationKind(value.kind)
  ) {
    return undefined;
  }
  return { taskAddress, objectAddress, kind: value.kind };
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(finiteNumber).filter((item): item is number => item !== undefined)
    : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isTaskState(value: unknown): value is RtosTaskState {
  return [
    'running', 'ready', 'pending-ready', 'blocked', 'suspended', 'deleted', 'unknown',
  ].includes(String(value));
}

function isObjectType(value: unknown): value is RtosObjectType {
  return [
    'queue',
    'mutex',
    'recursive-mutex',
    'binary-semaphore',
    'counting-semaphore',
    'queue-set',
    'unknown',
  ].includes(String(value));
}

function isRelationKind(value: unknown): value is RtosRelationKind {
  return [
    'waits-to-receive',
    'waits-to-send',
    'waits-for-mutex',
    'holds',
  ].includes(String(value));
}

function snapshotFailure(
  capturedAt: number,
  error: string,
  detail?: string,
  targetResumed = false,
): RtosSnapshot {
  return {
    success: false,
    kernel: 'freertos',
    capturedAt,
    tasks: [],
    objects: [],
    relations: [],
    warnings: detail === undefined ? [] : [trimOutput(detail)],
    targetResumed,
    error,
  };
}

function lastMeaningfulLine(value: string): string | undefined {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
}

function trimOutput(value: string): string {
  return value.length <= 64_000 ? value : value.slice(-64_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createFreeRtosGdbPython(): string {
  return String.raw`
import gdb
import json

MARKER = "${SNAPSHOT_MARKER}"
MAX_LIST_ITEMS = 1024
MAX_STACK_BYTES = 1024 * 1024

def as_int(value):
    return int(value)

def optional_field(value, name):
    try:
        return value[name]
    except Exception:
        return None

def optional_int(value, name):
    field = optional_field(value, name)
    if field is None:
        return None
    try:
        return as_int(field)
    except Exception:
        return None

def task_name(tcb, fallback):
    field = optional_field(tcb, "pcTaskName")
    if field is None:
        return fallback
    for candidate in (field, field.address):
        try:
            return candidate.string(errors="replace")
        except Exception:
            pass
    return fallback

def task_from_owner(owner, state, task_id):
    tcb_type = gdb.lookup_type("TCB_t").pointer()
    address = as_int(owner)
    tcb = owner.cast(tcb_type).dereference()
    stack_base = optional_int(tcb, "pxStack")
    stack_pointer = optional_int(tcb, "pxTopOfStack")
    stack_end = optional_int(tcb, "pxEndOfStack")
    stack_free = None
    stack_total = None
    stack_used = None
    if stack_base is not None and stack_pointer is not None and stack_pointer >= stack_base:
        readable = min(stack_pointer - stack_base, MAX_STACK_BYTES)
        if readable > 0:
            try:
                data = bytes(gdb.selected_inferior().read_memory(stack_base, readable))
                free_bytes = 0
                for byte in data:
                    if byte != 0xA5:
                        break
                    free_bytes += 1
                stack_free = free_bytes
            except Exception:
                pass
    if stack_base is not None and stack_end is not None and stack_end >= stack_base:
        try:
            stack_word_size = int(tcb["pxStack"].type.target().sizeof)
        except Exception:
            stack_word_size = 4
        stack_total = stack_end - stack_base + stack_word_size
        if stack_free is not None and stack_total > 0:
            stack_used = round(100.0 * (stack_total - stack_free) / stack_total, 1)
    return {
        "id": optional_int(tcb, "uxTCBNumber") or optional_int(tcb, "uxTaskNumber") or task_id,
        "address": address,
        "name": task_name(tcb, "Task %d" % task_id),
        "state": state,
        "priority": optional_int(tcb, "uxPriority") or 0,
        "basePriority": optional_int(tcb, "uxBasePriority"),
        "stackPointer": stack_pointer,
        "stackBase": stack_base,
        "stackEnd": stack_end,
        "stackFreeBytes": stack_free,
        "stackTotalBytes": stack_total,
        "stackUsedPercent": stack_used,
        "runtimeCounter": optional_int(tcb, "ulRunTimeCounter"),
    }

def suspended_or_blocked_state(owner):
    try:
        tcb_type = gdb.lookup_type("TCB_t").pointer()
        tcb = owner.cast(tcb_type).dereference()
        event_item = optional_field(tcb, "xEventListItem")
        if event_item is None:
            return "unknown"
        container = optional_field(event_item, "pvContainer")
        if container is None:
            return "unknown"
        return "blocked" if as_int(container) != 0 else "suspended"
    except Exception:
        return "unknown"

def visit_list(list_value, state, tasks):
    count = min(as_int(list_value["uxNumberOfItems"]), MAX_LIST_ITEMS)
    end_address = as_int(list_value["xListEnd"].address)
    node = list_value["xListEnd"]["pxNext"]
    for _ in range(count):
        if as_int(node) == end_address:
            break
        item = node.dereference()
        owner = item["pvOwner"]
        address = as_int(owner)
        if address not in tasks:
            resolved_state = suspended_or_blocked_state(owner) if state == "suspended-or-blocked" else state
            tasks[address] = task_from_owner(owner, resolved_state, len(tasks) + 1)
        node = item["pxNext"]

def list_owner_addresses(list_value):
    addresses = []
    count = min(as_int(list_value["uxNumberOfItems"]), MAX_LIST_ITEMS)
    end_address = as_int(list_value["xListEnd"].address)
    node = list_value["xListEnd"]["pxNext"]
    for _ in range(count):
        if as_int(node) == end_address:
            break
        item = node.dereference()
        addresses.append(as_int(item["pvOwner"]))
        node = item["pxNext"]
    return addresses

def queue_type_name(queue_type, item_size, length):
    if queue_type == 1:
        return "mutex"
    if queue_type == 2:
        return "counting-semaphore"
    if queue_type == 3:
        return "binary-semaphore"
    if queue_type == 4:
        return "recursive-mutex"
    if queue_type == 0:
        return "queue"
    if item_size == 0 and length == 1:
        return "binary-semaphore"
    if item_size == 0:
        return "counting-semaphore"
    return "unknown"

def mutex_holder(queue, queue_type):
    if queue_type not in (1, 4):
        return None
    try:
        address = as_int(queue["u"]["xSemaphore"]["xMutexHolder"])
        return address if address != 0 else None
    except Exception:
        return None

def registered_objects():
    registry = gdb.parse_and_eval("xQueueRegistry")
    queue_pointer = gdb.lookup_type("Queue_t").pointer()
    low, high = registry.type.range()
    objects = []
    relations = []
    for index in range(int(low), int(high) + 1):
        entry = registry[index]
        handle = entry["xHandle"]
        address = as_int(handle)
        if address == 0:
            continue
        name_pointer = entry["pcQueueName"]
        try:
            name = name_pointer.string(errors="replace")
        except Exception:
            name = "Object 0x%x" % address
        queue = handle.cast(queue_pointer).dereference()
        messages_waiting = optional_int(queue, "uxMessagesWaiting") or 0
        length = optional_int(queue, "uxLength") or 0
        item_size = optional_int(queue, "uxItemSize") or 0
        queue_type = optional_int(queue, "ucQueueType")
        object_type = queue_type_name(queue_type, item_size, length)
        waiting_to_send = list_owner_addresses(queue["xTasksWaitingToSend"])
        waiting_to_receive = list_owner_addresses(queue["xTasksWaitingToReceive"])
        holder = mutex_holder(queue, queue_type)
        objects.append({
            "address": address,
            "name": name,
            "type": object_type,
            "messagesWaiting": messages_waiting,
            "length": length,
            "itemSize": item_size,
            "holderTaskAddress": holder,
            "waitingToSendTaskAddresses": waiting_to_send,
            "waitingToReceiveTaskAddresses": waiting_to_receive,
        })
        if holder is not None:
            relations.append({
                "taskAddress": holder,
                "objectAddress": address,
                "kind": "holds",
            })
        receive_kind = "waits-for-mutex" if object_type in ("mutex", "recursive-mutex") else "waits-to-receive"
        for task_address in waiting_to_receive:
            relations.append({
                "taskAddress": task_address,
                "objectAddress": address,
                "kind": receive_kind,
            })
        for task_address in waiting_to_send:
            relations.append({
                "taskAddress": task_address,
                "objectAddress": address,
                "kind": "waits-to-send",
            })
    objects.sort(key=lambda item: item["name"])
    relations.sort(key=lambda item: (item["objectAddress"], item["kind"], item["taskAddress"]))
    return objects, relations

class Dockyard32FreeRtosSnapshot(gdb.Command):
    def __init__(self):
        super().__init__("dockyard32-freertos-snapshot", gdb.COMMAND_DATA)

    def invoke(self, argument, from_tty):
        try:
            current = as_int(gdb.parse_and_eval("pxCurrentTCB"))
            tasks = {}
            ready = gdb.parse_and_eval("pxReadyTasksLists")
            low, high = ready.type.range()
            for index in range(int(low), int(high) + 1):
                visit_list(ready[index], "ready", tasks)
            for expression, state in (
                ("*pxDelayedTaskList", "blocked"),
                ("*pxOverflowDelayedTaskList", "blocked"),
                ("xPendingReadyList", "pending-ready"),
                ("xSuspendedTaskList", "suspended-or-blocked"),
                ("xTasksWaitingTermination", "deleted"),
            ):
                try:
                    visit_list(gdb.parse_and_eval(expression), state, tasks)
                except Exception:
                    pass
            if current in tasks:
                tasks[current]["state"] = "running"
            runtime_total = sum(task.get("runtimeCounter") or 0 for task in tasks.values())
            if runtime_total > 0:
                for task in tasks.values():
                    counter = task.get("runtimeCounter")
                    if counter is not None:
                        task["runtimePercent"] = round(100.0 * counter / runtime_total, 1)
            warnings = []
            try:
                objects, relations = registered_objects()
                for relation in relations:
                    if relation["kind"].startswith("waits-"):
                        task = tasks.get(relation["taskAddress"])
                        if task is not None and task["state"] == "suspended":
                            task["state"] = "blocked"
            except Exception as object_error:
                objects, relations = [], []
                warnings.append("FreeRTOS queue registry unavailable: " + str(object_error))
            ordered = sorted(tasks.values(), key=lambda task: (task["state"] != "running", task["name"]))
            print(MARKER + json.dumps({
                "currentTaskAddress": current,
                "tasks": ordered,
                "objects": objects,
                "relations": relations,
                "warnings": warnings,
            }, separators=(",", ":")))
        except Exception as error:
            print(MARKER + json.dumps({"error": str(error)}, separators=(",", ":")))

class Dockyard32Detach(gdb.Command):
    def __init__(self):
        super().__init__("dockyard32-detach", gdb.COMMAND_RUNNING)

    def invoke(self, argument, from_tty):
        # The marker is deliberately emitted only after gdb.execute returns.
        # A failed detach raises here, leaves the marker absent, and makes the
        # caller report targetResumed=false even if snapshot JSON already exists.
        gdb.execute("detach", from_tty=False, to_string=False)
        print("${DETACH_MARKER}")

Dockyard32FreeRtosSnapshot()
Dockyard32Detach()
`;
}
