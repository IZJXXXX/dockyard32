import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { buildProject } from './build';
import { getDeviceStatus } from './device';
import {
  findFirmwareArtifact,
  flashFirmware,
  resetTarget,
} from './flash';
import { Dockyard32OperationLock } from './operationLock';
import type { DeviceStatus } from '../types/device';
import type { FlashResult } from '../types/flash';
import type {
  BuildAndRunOptions,
  FirmwareValidationResult,
  RunCoreDependencies,
  RunProgress,
  RunResult,
  RunSerialService,
  RunSerialSettings,
  RunStage,
} from '../types/run';
import type {
  SerialConfiguration,
  SerialPortInfo,
  SerialStatus,
  SerialWaitResult,
} from '../types/serial';

const DEFAULT_READY_PATTERN = 'SYSTEM READY';
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const FILE_TIME_TOLERANCE_MS = 5_000;
const defaultOperationLock = new Dockyard32OperationLock();
let nextRunId = 1;

interface MutableRunState {
  build?: RunResult['build'];
  firmwarePath?: string;
  flash?: RunResult['flash'];
  reset?: RunResult['reset'];
  serialConnected: boolean;
  serialPort?: string;
  readyDetected?: boolean;
  readyElapsedMs?: number;
  readonly warnings: string[];
}

interface SerialPreparation {
  readonly status: SerialStatus;
  readonly warning?: string;
}

export async function buildAndRun(
  options: BuildAndRunOptions,
): Promise<RunResult> {
  const runId = nextRunId;
  nextRunId += 1;
  const startedAt = Date.now();
  const readyCheckEnabled = options.waitForSerialReady ?? false;
  const readyPattern = options.readyPattern ?? DEFAULT_READY_PATTERN;
  const readyTimeoutMs = positiveTimeout(options.readyTimeoutMs);
  const initialSerialStatus = safeSerialStatus(options.serial);
  const state: MutableRunState = {
    serialConnected: initialSerialStatus.connected,
    serialPort: initialSerialStatus.port,
    warnings: [],
  };
  const operationLock = options.operationLock ?? defaultOperationLock;
  const lease = options.operationLease ?? operationLock.acquire('run');
  if (lease === undefined) {
    return failureResult(
      runId,
      startedAt,
      'preparing',
      'Build & Run already in progress',
      readyCheckEnabled,
      readyPattern,
      state,
      options.onProgress,
    );
  }
  if (lease.operation !== 'run') {
    lease.release();
    return failureResult(
      runId,
      startedAt,
      'preparing',
      'Invalid operation lease for Build & Run',
      readyCheckEnabled,
      readyPattern,
      state,
      options.onProgress,
    );
  }

  const dependencies = resolveDependencies(options.dependencies);
  let readyAbortController: AbortController | undefined;
  let readyPromise: Promise<SerialWaitResult> | undefined;

  try {
    progress(options, runId, 'preparing', 'Preparing Build & Run');
    const projectError = projectPreflight(options);
    if (projectError !== undefined) {
      return failureResult(
        runId,
        startedAt,
        'preparing',
        projectError,
        readyCheckEnabled,
        readyPattern,
        state,
        options.onProgress,
      );
    }

    progress(options, runId, 'building', 'Building project');
    const build = await dependencies.buildProject(options.project, {
      cmakeExecutable: options.cmakeExecutable,
      env: options.env,
      onOutput: options.onBuildOutput,
    });
    state.build = build;
    if (!build.success) {
      return failureResult(
        runId,
        startedAt,
        'building',
        build.errors[0]?.message ?? 'Build failed',
        readyCheckEnabled,
        readyPattern,
        state,
        options.onProgress,
      );
    }

    progress(
      options,
      runId,
      'firmware',
      'Build succeeded; finding firmware from successful build',
    );
    const discoveredFirmware =
      await dependencies.findFirmwareArtifact(options.project);
    if (discoveredFirmware === undefined) {
      return failureResult(
        runId,
        startedAt,
        'firmware',
        'Firmware not found after successful build',
        readyCheckEnabled,
        readyPattern,
        state,
        options.onProgress,
      );
    }
    const firmware = await dependencies.validateFirmwareArtifact(
      options.project,
      discoveredFirmware,
      Date.now(),
    );
    if (!firmware.success || firmware.firmwarePath === undefined) {
      return failureResult(
        runId,
        startedAt,
        'firmware',
        firmware.error ?? 'Firmware not found after successful build',
        readyCheckEnabled,
        readyPattern,
        state,
        options.onProgress,
      );
    }
    state.firmwarePath = firmware.firmwarePath;

    progress(options, runId, 'device', 'Checking ST-LINK');
    const device = await dependencies.getDeviceStatus(
      options.programmerExecutable,
    );
    const deviceError = devicePreflight(device);
    if (deviceError !== undefined) {
      return failureResult(
        runId,
        startedAt,
        'device',
        deviceError,
        readyCheckEnabled,
        readyPattern,
        state,
        options.onProgress,
      );
    }

    progress(options, runId, 'flashing', 'Flashing firmware');
    const flash = await dependencies.flashFirmware(options.project, {
      programmerExecutable: options.programmerExecutable,
      firmwarePath: firmware.firmwarePath,
      verify: options.verify ?? true,
      reset: false,
      onOutput: options.onProgrammerOutput,
    });
    state.flash = flash;
    if (!flash.success) {
      const failedStage = isVerifyFailure(flash) ? 'verifying' : 'flashing';
      return failureResult(
        runId,
        startedAt,
        failedStage,
        flash.error ?? (failedStage === 'verifying' ? 'Verify failed' : 'Flash failed'),
        readyCheckEnabled,
        readyPattern,
        state,
        options.onProgress,
      );
    }
    if (flash.verify) {
      progress(options, runId, 'verifying', 'Firmware verified');
    }

    progress(
      options,
      runId,
      'serial',
      'Flash succeeded; preparing serial connection',
    );
    const serialPreparation = await prepareSerial(
      options.serial,
      options.serialSettings,
    );
    state.serialConnected = serialPreparation.status.connected;
    state.serialPort = serialPreparation.status.port;
    if (serialPreparation.warning !== undefined) {
      state.warnings.push(serialPreparation.warning);
    }
    progress(
      options,
      runId,
      'serial',
      state.serialConnected
        ? `Serial connected: ${state.serialPort ?? 'unknown port'}`
        : serialPreparation.warning ?? 'Serial unavailable',
    );
    if (state.serialConnected && options.clearSerialBeforeRun === true) {
      options.serial?.clearSerialLog();
    }

    if (readyCheckEnabled && state.serialConnected && options.serial !== undefined) {
      readyAbortController = new AbortController();
      readyPromise = options.serial.waitSerial(readyPattern, readyTimeoutMs, {
        includeExisting: false,
        signal: readyAbortController.signal,
      });
    } else if (readyCheckEnabled) {
      state.readyDetected = false;
      state.warnings.push(
        'Serial is unavailable; runtime readiness was not checked.',
      );
    }

    progress(options, runId, 'resetting', 'Resetting target');
    const reset = await dependencies.resetTarget({
      programmerExecutable: options.programmerExecutable,
      onOutput: options.onProgrammerOutput,
    });
    state.reset = reset;
    if (!reset.success) {
      readyAbortController?.abort();
      if (readyPromise !== undefined) {
        await readyPromise;
      }
      return failureResult(
        runId,
        startedAt,
        'resetting',
        reset.error ?? 'Reset failed',
        readyCheckEnabled,
        readyPattern,
        state,
        options.onProgress,
      );
    }

    if (readyPromise !== undefined) {
      progress(
        options,
        runId,
        'waiting',
        `Waiting for serial pattern: ${readyPattern}`,
      );
      const ready = await readyPromise;
      state.readyDetected = ready.success;
      state.readyElapsedMs = ready.elapsedMs;
      if (!ready.success) {
        state.warnings.push(readyWarning(ready));
      }
    }

    if (options.serial !== undefined) {
      const finalSerialStatus = options.serial.getSerialStatus();
      state.serialConnected = finalSerialStatus.connected;
      state.serialPort = finalSerialStatus.port;
    }

    const completedAt = Date.now();
    progress(options, runId, 'complete', 'Build & Run complete');
    return {
      runId,
      success: true,
      status: state.warnings.length === 0 ? 'success' : 'warning',
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      build: state.build,
      firmwarePath: state.firmwarePath,
      flash: state.flash,
      reset: state.reset,
      serialConnected: state.serialConnected,
      serialPort: state.serialPort,
      readyCheckEnabled,
      readyDetected: state.readyDetected,
      readyPattern: readyCheckEnabled ? readyPattern : undefined,
      readyElapsedMs: state.readyElapsedMs,
      warnings: [...state.warnings],
    };
  } catch (error: unknown) {
    readyAbortController?.abort();
    if (readyPromise !== undefined) {
      await readyPromise;
    }
    return failureResult(
      runId,
      startedAt,
      'failed',
      errorMessage(error),
      readyCheckEnabled,
      readyPattern,
      state,
      options.onProgress,
    );
  } finally {
    lease.release();
  }
}

export async function validateFirmwareArtifact(
  project: BuildAndRunOptions['project'],
  firmwarePath: string,
  completedAt: number,
): Promise<FirmwareValidationResult> {
  if (project.buildDir === undefined) {
    return { success: false, error: 'Firmware build directory is unavailable' };
  }

  try {
    const [realBuildDirectory, realFirmwarePath, firmwareStats] = await Promise.all([
      fs.realpath(project.buildDir),
      fs.realpath(firmwarePath),
      fs.stat(firmwarePath),
    ]);
    if (
      !firmwareStats.isFile() ||
      firmwareStats.size === 0 ||
      !isWithin(realBuildDirectory, realFirmwarePath)
    ) {
      return {
        success: false,
        error: 'Firmware artifact is not a non-empty file inside the current build directory',
      };
    }
    if (
      firmwareStats.mtimeMs <= 0 ||
      firmwareStats.mtimeMs > completedAt + FILE_TIME_TOLERANCE_MS
    ) {
      return { success: false, error: 'Firmware modification time is invalid' };
    }
    return { success: true, firmwarePath: realFirmwarePath };
  } catch {
    return {
      success: false,
      error: 'Firmware not found after successful build',
    };
  }
}

function resolveDependencies(
  overrides: Partial<RunCoreDependencies> | undefined,
): RunCoreDependencies {
  return {
    buildProject: overrides?.buildProject ?? buildProject,
    findFirmwareArtifact:
      overrides?.findFirmwareArtifact ?? findFirmwareArtifact,
    validateFirmwareArtifact:
      overrides?.validateFirmwareArtifact ?? validateFirmwareArtifact,
    getDeviceStatus: overrides?.getDeviceStatus ?? getDeviceStatus,
    flashFirmware: overrides?.flashFirmware ?? flashFirmware,
    resetTarget: overrides?.resetTarget ?? resetTarget,
  };
}

function projectPreflight(options: BuildAndRunOptions): string | undefined {
  const project = options.project;
  if (!project.detected) {
    return project.reason === 'no-workspace'
      ? 'No workspace opened'
      : 'No STM32 project detected';
  }
  if (project.buildSystem !== 'cmake') {
    return project.buildSystem === 'mdk'
      ? 'Keil MDK project must be imported to native macOS CMake before Build & Run'
      : 'Supported CMake project not detected';
  }
  return project.buildSystem === 'cmake' && options.cmakeExecutable === undefined
    ? 'CMake executable not found'
    : undefined;
}

function devicePreflight(status: DeviceStatus): string | undefined {
  if (!status.programmerAvailable) {
    return 'STM32CubeProgrammer CLI not found';
  }
  return status.probeConnected ? undefined : 'No ST-LINK probe detected';
}

async function prepareSerial(
  serial: RunSerialService | undefined,
  settings: RunSerialSettings | undefined,
): Promise<SerialPreparation> {
  if (serial === undefined) {
    return {
      status: disconnectedStatus(),
      warning: 'Serial service is unavailable; startup output was not captured.',
    };
  }
  const current = serial.getSerialStatus();
  if (current.connected) {
    return { status: current };
  }
  if (settings === undefined) {
    return {
      status: current,
      warning: 'Serial configuration is unavailable; startup output was not captured.',
    };
  }

  const ports = await serial.listSerialPorts();
  const configuration = resolveSerialConfiguration(settings, ports);
  if ('warning' in configuration) {
    return { status: serial.getSerialStatus(), warning: configuration.warning };
  }
  const connected = await serial.connectSerial(configuration);
  const status = serial.getSerialStatus();
  return connected.success
    ? { status }
    : {
        status,
        warning: `Serial connection was not established: ${connected.error ?? 'Unknown error'}`,
      };
}

function resolveSerialConfiguration(
  settings: RunSerialSettings,
  ports: readonly SerialPortInfo[],
): SerialConfiguration | { readonly warning: string } {
  if (settings.serialPort !== 'auto') {
    const configured = ports.find((port) => port.path === settings.serialPort);
    if (configured === undefined) {
      return {
        warning: `Configured serial port is unavailable: ${settings.serialPort}`,
      };
    }
    return serialConfiguration(settings, configured.path);
  }

  const candidates = ports.filter((port) => isAutomaticSerialCandidate(port.path));
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return serialConfiguration(settings, candidates[0].path);
  }
  if (candidates.length > 1) {
    return {
      warning: 'Multiple serial ports are available; serial connection was not established.',
    };
  }
  return {
    warning: 'No unambiguous /dev/cu.* serial port is available.',
  };
}

function serialConfiguration(
  settings: RunSerialSettings,
  serialPath: string,
): SerialConfiguration {
  return {
    path: serialPath,
    baudRate: settings.baudRate,
    dataBits: settings.dataBits,
    stopBits: settings.stopBits,
    parity: settings.parity,
  };
}

function isAutomaticSerialCandidate(serialPath: string): boolean {
  const normalized = serialPath.toLowerCase();
  return (
    serialPath.startsWith('/dev/cu.') &&
    !normalized.includes('bluetooth-incoming-port') &&
    !normalized.includes('debug-console')
  );
}

function isVerifyFailure(result: FlashResult): boolean {
  return (
    result.verify &&
    /\bverify|verification\b/iu.test(
      `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`,
    )
  );
}

function readyWarning(result: SerialWaitResult): string {
  if (/disconnect/iu.test(result.error ?? '')) {
    return 'Serial disconnected while waiting for runtime readiness.';
  }
  if (/cancel/iu.test(result.error ?? '')) {
    return 'Runtime readiness wait was cancelled.';
  }
  return 'Firmware was programmed and reset successfully, but runtime readiness was not confirmed.';
}

function failureResult(
  runId: number,
  startedAt: number,
  failedStage: RunStage,
  error: string,
  readyCheckEnabled: boolean,
  readyPattern: string,
  state: MutableRunState,
  onProgress: ((progress: RunProgress) => void) | undefined,
): RunResult {
  const completedAt = Date.now();
  onProgress?.({ runId, stage: 'failed', message: error });
  return {
    runId,
    success: false,
    status: 'failed',
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    failedStage,
    build: state.build,
    firmwarePath: state.firmwarePath,
    flash: state.flash,
    reset: state.reset,
    serialConnected: state.serialConnected,
    serialPort: state.serialPort,
    readyCheckEnabled,
    readyDetected: state.readyDetected,
    readyPattern: readyCheckEnabled ? readyPattern : undefined,
    readyElapsedMs: state.readyElapsedMs,
    warnings: [...state.warnings],
    error,
  };
}

function progress(
  options: BuildAndRunOptions,
  runId: number,
  stage: RunStage,
  message: string,
): void {
  options.onProgress?.({ runId, stage, message });
}

function positiveTimeout(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_READY_TIMEOUT_MS;
}

function disconnectedStatus(): SerialStatus {
  return {
    connected: false,
    state: 'disconnected',
    bytesReceived: 0,
    bytesSent: 0,
  };
}

function safeSerialStatus(serial: RunSerialService | undefined): SerialStatus {
  if (serial === undefined) {
    return disconnectedStatus();
  }
  try {
    return serial.getSerialStatus();
  } catch {
    return disconnectedStatus();
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
