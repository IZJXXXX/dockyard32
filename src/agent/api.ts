import * as path from 'node:path';

import { buildProject } from '../core/build';
import { getDeviceStatus } from '../core/device';
import {
  findFirmwareArtifact,
  flashFirmware,
  resetTarget,
} from '../core/flash';
import { Dockyard32OperationLock } from '../core/operationLock';
import { detectProject } from '../core/project';
import { buildAndRun, validateFirmwareArtifact } from '../core/run';
import { readLastRunResult, writeLastRunResult } from '../core/runStore';
import { discoverDevelopmentTools } from '../core/tools';
import type {
  AgentApi,
  AgentError,
  AgentErrorCode,
  AgentProbeInfo,
  AgentProjectInfo,
  AgentResult,
  AgentSendSerialInput,
  AgentSerialLog,
  AgentToolInfo,
  AgentToolStatus,
  AgentWaitSerialInput,
} from '../types/agent';
import type { BuildOptions, BuildResult } from '../types/build';
import type { DeviceStatus } from '../types/device';
import type {
  FlashOptions,
  FlashResult,
  ResetOptions,
  ResetResult,
} from '../types/flash';
import type { Stm32ProjectInfo } from '../types/project';
import type {
  OperationLease,
  OperationLock,
  RunResult,
  RunSerialService,
  Dockyard32Operation,
} from '../types/run';
import type { SerialStatus, SerialWaitResult } from '../types/serial';
import type { DevelopmentTools, ToolDiscoveryOptions } from '../types/tools';
import {
  readAgentWorkspaceConfiguration,
  type AgentWorkspaceConfiguration,
} from './config';

const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const MAX_PATTERN_LENGTH = 1_024;
const MAX_SEND_LENGTH = 64 * 1_024;

export interface AgentApiDependencies {
  readonly detectProject: (workspacePath: string) => Promise<Stm32ProjectInfo>;
  readonly discoverDevelopmentTools: (
    options: ToolDiscoveryOptions,
  ) => Promise<DevelopmentTools>;
  readonly getDeviceStatus: (
    programmerExecutable?: string,
  ) => Promise<DeviceStatus>;
  readonly buildProject: (
    project: Stm32ProjectInfo,
    options: BuildOptions,
  ) => Promise<BuildResult>;
  readonly findFirmwareArtifact: (
    project: Stm32ProjectInfo,
  ) => Promise<string | undefined>;
  readonly validateFirmwareArtifact: typeof validateFirmwareArtifact;
  readonly flashFirmware: (
    project: Stm32ProjectInfo,
    options: FlashOptions,
  ) => Promise<FlashResult>;
  readonly resetTarget: (options: ResetOptions) => Promise<ResetResult>;
  readonly buildAndRun: typeof buildAndRun;
  readonly readConfiguration: (
    workspacePath: string,
  ) => Promise<AgentWorkspaceConfiguration>;
  readonly readLastRun: (workspacePath: string) => Promise<RunResult | undefined>;
  readonly writeLastRun: (
    workspacePath: string,
    result: RunResult,
  ) => Promise<void>;
}

export interface CreateAgentApiOptions {
  readonly workspacePath: string;
  readonly operationLock?: OperationLock;
  readonly serial?: RunSerialService & {
    getSerialLog(): string;
    sendSerial(text: string): Promise<{ readonly success: boolean; readonly error?: string }>;
  };
  readonly serialOwnedByExtension?: boolean;
  readonly dependencies?: Partial<AgentApiDependencies>;
}

export function createAgentApi(options: CreateAgentApiOptions): AgentApi {
  return new Stm32AgentApi(options);
}

class Stm32AgentApi implements AgentApi {
  private readonly workspacePath: string;
  private readonly operationLock: OperationLock;
  private readonly dependencies: AgentApiDependencies;
  private readonly serial?: CreateAgentApiOptions['serial'];
  private readonly serialOwnedByExtension: boolean;
  private validatedFirmwarePath?: string;

  public constructor(options: CreateAgentApiOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.operationLock =
      options.operationLock ?? new Dockyard32OperationLock(this.workspacePath);
    this.serial = options.serial;
    this.serialOwnedByExtension = options.serialOwnedByExtension ?? false;
    this.dependencies = {
      detectProject: options.dependencies?.detectProject ?? detectProject,
      discoverDevelopmentTools:
        options.dependencies?.discoverDevelopmentTools ?? discoverDevelopmentTools,
      getDeviceStatus: options.dependencies?.getDeviceStatus ?? getDeviceStatus,
      buildProject: options.dependencies?.buildProject ?? buildProject,
      findFirmwareArtifact:
        options.dependencies?.findFirmwareArtifact ?? findFirmwareArtifact,
      validateFirmwareArtifact:
        options.dependencies?.validateFirmwareArtifact ?? validateFirmwareArtifact,
      flashFirmware: options.dependencies?.flashFirmware ?? flashFirmware,
      resetTarget: options.dependencies?.resetTarget ?? resetTarget,
      buildAndRun: options.dependencies?.buildAndRun ?? buildAndRun,
      readConfiguration:
        options.dependencies?.readConfiguration ?? readAgentWorkspaceConfiguration,
      readLastRun: options.dependencies?.readLastRun ?? readLastRunResult,
      writeLastRun: options.dependencies?.writeLastRun ?? writeLastRunResult,
    };
  }

  public async getProjectInfo(): Promise<AgentResult<AgentProjectInfo>> {
    return this.protect<AgentProjectInfo>(async () => {
      const project = await this.requireProject();
      if (!project.success) {
        return propagateFailure(project);
      }
      return ok({
        projectName: project.data.projectName,
        workspacePath: project.data.workspacePath ?? this.workspacePath,
        projectRoot: project.data.projectRoot,
        mcu: project.data.mcu,
        family: project.data.family,
        buildSystem: project.data.buildSystem,
        buildDir: project.data.buildDir,
        configurePreset: project.data.configurePreset,
        buildPreset: project.data.buildPreset,
        iocPath: project.data.iocPath,
      });
    });
  }

  public async getToolStatus(): Promise<AgentResult<AgentToolStatus>> {
    return this.protect(async () => {
      const tools = await this.loadTools();
      return ok({
        cmake: toolInfo(tools.cmake),
        ninja: toolInfo(tools.ninja),
        armGcc: toolInfo(tools.armGcc),
        programmer: toolInfo(tools.programmer),
        detectedAt: tools.detectedAt,
      });
    });
  }

  public async getProbeInfo(): Promise<AgentResult<AgentProbeInfo>> {
    return this.protect(async () => {
      const tools = await this.loadTools();
      if (!tools.programmer.available) {
        return fail('PROGRAMMER_NOT_FOUND', 'STM32CubeProgrammer CLI was not found.', 'probe');
      }
      const status = await this.dependencies.getDeviceStatus(
        tools.programmer.executable,
      );
      const error = probeError(status);
      if (error !== undefined) {
        return { success: false, error };
      }
      const probe = status.probes[0];
      const project = await this.dependencies.detectProject(this.workspacePath);
      return ok({
        connected: true,
        count: status.probes.length,
        serialNumber: probe?.serialNumber,
        firmware: probe?.firmwareVersion,
        board: probe?.board,
        targetMcu: project.detected ? project.mcu : undefined,
      });
    });
  }

  public getSerialStatus(): Promise<AgentResult<SerialStatus>> {
    const serial = this.requireSerial();
    return Promise.resolve(
      serial.success
        ? ok(serial.data.getSerialStatus())
        : propagateFailure(serial),
    );
  }

  public getSerialLog(
    maxLines = DEFAULT_LOG_LINES,
  ): Promise<AgentResult<AgentSerialLog>> {
    if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > MAX_LOG_LINES) {
      return Promise.resolve(fail(
        'INVALID_ARGUMENT',
        `maxLines must be an integer between 1 and ${MAX_LOG_LINES}.`,
        'serial',
      ));
    }
    const serial = this.requireSerial();
    if (!serial.success) {
      return Promise.resolve(propagateFailure(serial));
    }
    const raw = serial.data.getSerialLog();
    const lines = raw.split('\n');
    const hasTrailingLine = raw.endsWith('\n');
    if (hasTrailingLine) {
      lines.pop();
    }
    const truncated = lines.length > maxLines;
    const selected = truncated ? lines.slice(-maxLines) : lines;
    const text = `${selected.join('\n')}${hasTrailingLine && selected.length > 0 ? '\n' : ''}`;
    return Promise.resolve(ok({ lineCount: selected.length, truncated, text }));
  }

  public async getLastRun(): Promise<AgentResult<RunResult>> {
    return this.protect(async () => {
      const result = await this.dependencies.readLastRun(this.workspacePath);
      return result === undefined
        ? fail('NO_LAST_RUN', 'No Build & Run result is available.', 'run')
        : ok(result, result.warnings);
    });
  }

  public async build(): Promise<AgentResult<BuildResult>> {
    return this.runLocked('build', async (lease, configuration) => {
      const project = await this.requireProject();
      if (!project.success) {
        lease.release();
        return propagateFailure(project);
      }
      const tools = await this.loadTools(configuration);
      if (project.data.buildSystem === 'cmake' && !tools.cmake.available) {
        lease.release();
        return fail('CMAKE_NOT_FOUND', 'CMake executable was not found.', 'build');
      }
      const task = this.dependencies.buildProject(project.data, {
        cmakeExecutable: tools.cmake.executable,
        env: toolEnvironment(tools),
      });
      const result = await this.awaitOperation(task, configuration.timeouts.buildMs, lease, (build) =>
        build.success
          ? ok(build)
          : failWithData('BUILD_FAILED', 'STM32 project build failed.', 'build', build),
      );
      if (!result.success) {
        this.validatedFirmwarePath = undefined;
        return result;
      }
      const discovered = await this.dependencies.findFirmwareArtifact(project.data);
      if (discovered === undefined) {
        this.validatedFirmwarePath = undefined;
        return ok(result.data, [
          'Build succeeded, but no firmware artifact was found for a later Flash operation.',
        ]);
      }
      const firmware = await this.dependencies.validateFirmwareArtifact(
        project.data,
        discovered,
        Date.now(),
      );
      this.validatedFirmwarePath = firmware.success
        ? firmware.firmwarePath
        : undefined;
      return this.validatedFirmwarePath === undefined
        ? ok(result.data, [
            firmware.error ??
              'Build succeeded, but the firmware artifact could not be validated.',
          ])
        : result;
    });
  }

  public async flash(): Promise<AgentResult<FlashResult>> {
    return this.runLocked('flash', async (lease, configuration) => {
      const context = await this.requireProgrammingContext(configuration);
      if (!context.success) {
        lease.release();
        return propagateFailure(context);
      }
      const firmwarePath = this.validatedFirmwarePath;
      if (firmwarePath === undefined) {
        lease.release();
        return fail(
          'FIRMWARE_NOT_FOUND',
          'No firmware has been validated by a successful Agent build in this server session.',
          'flash',
        );
      }
      const firmware = await this.dependencies.validateFirmwareArtifact(
        context.data.project,
        firmwarePath,
        Date.now(),
      );
      if (!firmware.success || firmware.firmwarePath === undefined) {
        lease.release();
        return fail(
          'FIRMWARE_NOT_FOUND',
          firmware.error ?? 'The firmware artifact is invalid.',
          'flash',
        );
      }
      const task = this.dependencies.flashFirmware(context.data.project, {
        programmerExecutable: context.data.tools.programmer.executable,
        firmwarePath: firmware.firmwarePath,
        verify: configuration.flashVerify,
        reset: false,
      });
      return this.awaitOperation(task, configuration.timeouts.flashMs, lease, (result) => {
        if (result.success) {
          return ok(result);
        }
        const code = verifyFailed(result) ? 'VERIFY_FAILED' : 'FLASH_FAILED';
        return failWithData(code, result.error ?? 'Firmware programming failed.', 'flash', result);
      });
    });
  }

  public async reset(): Promise<AgentResult<ResetResult>> {
    return this.runLocked('reset', async (lease, configuration) => {
      const context = await this.requireProgrammingContext(configuration);
      if (!context.success) {
        lease.release();
        return propagateFailure(context);
      }
      const task = this.dependencies.resetTarget({
        programmerExecutable: context.data.tools.programmer.executable,
      });
      return this.awaitOperation(task, configuration.timeouts.resetMs, lease, (result) =>
        result.success
          ? ok(result)
          : failWithData('RESET_FAILED', result.error ?? 'Target reset failed.', 'reset', result),
      );
    });
  }

  public async buildAndRun(): Promise<AgentResult<RunResult>> {
    return this.runLocked('run', async (lease, configuration) => {
      const project = await this.requireProject();
      if (!project.success) {
        lease.release();
        return propagateFailure(project);
      }
      const tools = await this.loadTools(configuration);
      if (project.data.buildSystem === 'cmake' && !tools.cmake.available) {
        lease.release();
        return fail('CMAKE_NOT_FOUND', 'CMake executable was not found.', 'run');
      }
      if (!tools.programmer.available) {
        lease.release();
        return fail('PROGRAMMER_NOT_FOUND', 'STM32CubeProgrammer CLI was not found.', 'run');
      }
      const probe = await this.dependencies.getDeviceStatus(
        tools.programmer.executable,
      );
      const probeFailure = probeError(probe);
      if (probeFailure !== undefined) {
        lease.release();
        return { success: false, error: probeFailure };
      }
      const task = this.dependencies.buildAndRun({
        project: project.data,
        cmakeExecutable: tools.cmake.executable,
        programmerExecutable: tools.programmer.executable,
        env: toolEnvironment(tools),
        verify: configuration.flashVerify,
        serial: this.serial,
        serialSettings: configuration.serial,
        waitForSerialReady:
          this.serial === undefined
            ? false
            : configuration.run.waitForSerialReady,
        readyPattern: configuration.run.readyPattern,
        readyTimeoutMs: configuration.run.readyTimeoutMs,
        clearSerialBeforeRun: configuration.run.clearSerialBeforeRun,
        operationLock: this.operationLock,
        operationLease: lease,
      });
      const result = await this.awaitOperation(task, configuration.timeouts.runMs, lease, (run) => {
        return run.success
          ? ok(run, run.warnings)
          : failWithData(runErrorCode(run), run.error ?? 'Build & Run failed.', run.failedStage, run, run.warnings);
      }, false);
      if (result.data !== undefined) {
        try {
          await this.dependencies.writeLastRun(this.workspacePath, result.data);
        } catch (error: unknown) {
          const warning = `Unable to persist Last Run: ${errorMessage(error)}`;
          return result.success
            ? ok(result.data, [...(result.warnings ?? []), warning])
            : {
                ...result,
                warnings: [...(result.warnings ?? []), warning],
              };
        }
      }
      return result;
    });
  }

  public async sendSerial(
    input: AgentSendSerialInput,
  ): Promise<AgentResult<SerialStatus>> {
    if (input.text.length === 0 || input.text.length > MAX_SEND_LENGTH) {
      return fail(
        'INVALID_ARGUMENT',
        `text must contain between 1 and ${MAX_SEND_LENGTH} characters.`,
        'serial',
      );
    }
    const serial = this.requireSerial();
    if (!serial.success) {
      return propagateFailure(serial);
    }
    if (!serial.data.getSerialStatus().connected) {
      return fail('SERIAL_NOT_CONNECTED', 'The Dockyard32 serial port is not connected.', 'serial');
    }
    const result = await serial.data.sendSerial(
      `${input.text}${lineEnding(input.lineEnding ?? 'none')}`,
    );
    return result.success
      ? ok(serial.data.getSerialStatus())
      : fail('SERIAL_WRITE_FAILED', result.error ?? 'Serial write failed.', 'serial');
  }

  public async waitSerial(
    input: AgentWaitSerialInput,
  ): Promise<AgentResult<SerialWaitResult>> {
    const timeoutMs = input.timeoutMs ?? 5_000;
    if (
      input.pattern.length === 0 ||
      input.pattern.length > MAX_PATTERN_LENGTH ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_WAIT_TIMEOUT_MS
    ) {
      return fail(
        'INVALID_ARGUMENT',
        `pattern must contain 1-${MAX_PATTERN_LENGTH} characters and timeoutMs must be 1-${MAX_WAIT_TIMEOUT_MS}.`,
        'serial',
      );
    }
    const serial = this.requireSerial();
    if (!serial.success) {
      return propagateFailure(serial);
    }
    if (!serial.data.getSerialStatus().connected) {
      return fail('SERIAL_NOT_CONNECTED', 'The Dockyard32 serial port is not connected.', 'serial');
    }
    const result = await serial.data.waitSerial(input.pattern, timeoutMs);
    return result.success
      ? ok(result)
      : failWithData('SERIAL_WAIT_TIMEOUT', result.error ?? 'Serial wait timed out.', 'serial', result);
  }

  private async runLocked<T>(
    operation: Dockyard32Operation,
    callback: (
      lease: OperationLease,
      configuration: AgentWorkspaceConfiguration,
    ) => Promise<AgentResult<T>>,
  ): Promise<AgentResult<T>> {
    return this.protect(async () => {
      const lease = this.operationLock.acquire(operation);
      if (lease === undefined) {
        return fail(
          'OPERATION_BUSY',
          `Another STM32 operation is in progress: ${this.operationLock.getActiveOperation() ?? 'unknown'}.`,
          operation,
        );
      }
      try {
        const configuration = await this.dependencies.readConfiguration(
          this.workspacePath,
        );
        return await callback(lease, configuration);
      } catch (error: unknown) {
        lease.release();
        throw error;
      }
    });
  }

  private async awaitOperation<T, U>(
    task: Promise<T>,
    timeoutMs: number,
    lease: OperationLease,
    map: (value: T) => AgentResult<U>,
    release = true,
  ): Promise<AgentResult<U>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = task.then(
      (value) => {
        if (release) {
          lease.release();
        }
        return map(value);
      },
      (error: unknown) => {
        lease.release();
        throw error;
      },
    );
    const timeout = new Promise<AgentResult<U>>((resolve) => {
      timer = setTimeout(() => {
        resolve(
          fail(
            'OPERATION_TIMEOUT',
            `The STM32 operation exceeded ${timeoutMs} ms and is still finishing in the background.`,
            lease.operation,
          ),
        );
      }, timeoutMs);
    });
    const result = await Promise.race([completed, timeout]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (!release) {
      completed.then(
        () => lease.release(),
        () => lease.release(),
      );
    }
    return result;
  }

  private async requireProject(): Promise<AgentResult<Stm32ProjectInfo>> {
    const project = await this.dependencies.detectProject(this.workspacePath);
    if (!project.detected) {
      return project.reason === 'no-workspace'
        ? fail('NO_WORKSPACE', 'No STM32 workspace is configured.', 'project')
        : fail('NOT_STM32_PROJECT', 'The configured workspace is not an STM32 project.', 'project');
    }
    if (project.buildSystem !== 'cmake') {
      return fail('NOT_STM32_PROJECT', 'A native macOS CMake STM32 project is required; import Keil MDK first.', 'project');
    }
    return ok(project);
  }

  private async loadTools(
    configuration?: AgentWorkspaceConfiguration,
  ): Promise<DevelopmentTools> {
    const effective =
      configuration ??
      (await this.dependencies.readConfiguration(this.workspacePath));
    return this.dependencies.discoverDevelopmentTools({
      configured: effective.configuredTools,
    });
  }

  private async requireProgrammingContext(
    configuration: AgentWorkspaceConfiguration,
  ): Promise<
    AgentResult<{
      readonly project: Stm32ProjectInfo;
      readonly tools: DevelopmentTools;
    }>
  > {
    const project = await this.requireProject();
    if (!project.success) {
      return propagateFailure(project);
    }
    const tools = await this.loadTools(configuration);
    if (!tools.programmer.available) {
      return fail('PROGRAMMER_NOT_FOUND', 'STM32CubeProgrammer CLI was not found.', 'probe');
    }
    const status = await this.dependencies.getDeviceStatus(
      tools.programmer.executable,
    );
    const error = probeError(status);
    return error === undefined
      ? ok({ project: project.data, tools })
      : { success: false, error };
  }

  private requireSerial(): AgentResult<NonNullable<CreateAgentApiOptions['serial']>> {
    if (this.serial !== undefined) {
      return ok(this.serial);
    }
    return this.serialOwnedByExtension
      ? fail(
          'SERIAL_OWNED_BY_EXTENSION',
          'Serial is owned by the VS Code Extension Host; this MCP process will not open the port.',
          'serial',
        )
      : fail('SERIAL_NOT_CONNECTED', 'No serial backend is available.', 'serial');
  }

  private async protect<T>(
    callback: () => Promise<AgentResult<T>>,
  ): Promise<AgentResult<T>> {
    try {
      return await callback();
    } catch (error: unknown) {
      return fail('INTERNAL_ERROR', errorMessage(error), 'internal');
    }
  }
}

function ok<T>(data: T, warnings?: readonly string[]): AgentResult<T> {
  return warnings !== undefined && warnings.length > 0
    ? { success: true, data, warnings }
    : { success: true, data };
}

function fail<T>(
  code: AgentErrorCode,
  message: string,
  stage?: string,
): AgentResult<T> {
  return { success: false, error: { code, message, stage } };
}

function failWithData<T>(
  code: AgentErrorCode,
  message: string,
  stage: string | undefined,
  data: T,
  warnings?: readonly string[],
): AgentResult<T> {
  return { success: false, data, error: { code, message, stage }, warnings };
}

function propagateFailure<T>(
  result: AgentResult<unknown>,
): AgentResult<T> {
  if (result.success) {
    return fail('INTERNAL_ERROR', 'Expected a failed Agent result.', 'internal');
  }
  return {
    success: false,
    error: result.error,
    warnings: result.warnings,
  };
}

function probeError(status: DeviceStatus): AgentError | undefined {
  if (!status.programmerAvailable) {
    return {
      code: 'PROGRAMMER_NOT_FOUND',
      message: 'STM32CubeProgrammer CLI was not found.',
      stage: 'probe',
    };
  }
  if (!status.probeConnected || status.probes.length === 0) {
    return {
      code: 'STLINK_NOT_CONNECTED',
      message: 'No ST-LINK probe is currently connected.',
      stage: 'probe',
    };
  }
  if (status.probes.length > 1) {
    return {
      code: 'MULTIPLE_STLINK_PROBES',
      message: 'Multiple ST-LINK probes are connected; select a single probe before continuing.',
      stage: 'probe',
    };
  }
  return undefined;
}

function toolInfo(tool: DevelopmentTools['cmake']): AgentToolInfo {
  return {
    found: tool.available,
    path: tool.executable,
    source: tool.source,
  };
}

function toolEnvironment(tools: DevelopmentTools): NodeJS.ProcessEnv {
  const directories = [tools.ninja.executable, tools.armGcc.executable]
    .filter((value): value is string => value !== undefined)
    .map((value) => path.dirname(value));
  return {
    ...process.env,
    PATH: [...new Set([...directories, process.env.PATH ?? ''])]
      .filter((value) => value.length > 0)
      .join(path.delimiter),
  };
}

function verifyFailed(result: FlashResult): boolean {
  return (
    result.verify &&
    /\bverify|verification\b/iu.test(
      `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`,
    )
  );
}

function runErrorCode(result: RunResult): AgentErrorCode {
  switch (result.failedStage) {
    case 'building':
      return 'BUILD_FAILED';
    case 'firmware':
      return 'FIRMWARE_NOT_FOUND';
    case 'device':
      return /multiple/iu.test(result.error ?? '')
        ? 'MULTIPLE_STLINK_PROBES'
        : 'STLINK_NOT_CONNECTED';
    case 'flashing':
      return 'FLASH_FAILED';
    case 'verifying':
      return 'VERIFY_FAILED';
    case 'resetting':
      return 'RESET_FAILED';
    case 'preparing':
      return /progress/iu.test(result.error ?? '')
        ? 'OPERATION_BUSY'
        : 'INVALID_ARGUMENT';
    default:
      return 'INTERNAL_ERROR';
  }
}

function lineEnding(value: AgentSendSerialInput['lineEnding']): string {
  switch (value) {
    case 'lf':
      return '\n';
    case 'cr':
      return '\r';
    case 'crlf':
      return '\r\n';
    case 'none':
    case undefined:
      return '';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
