import type { BuildOptions, BuildOutputEvent, BuildResult } from './build';
import type { DeviceStatus } from './device';
import type {
  FlashOptions,
  FlashResult,
  ProgrammerOutputEvent,
  ResetOptions,
  ResetResult,
} from './flash';
import type { Stm32ProjectInfo } from './project';
import type {
  SerialConfiguration,
  SerialOperationResult,
  SerialPortInfo,
  SerialStatus,
  SerialWaitOptions,
  SerialWaitResult,
} from './serial';

export type RunStage =
  | 'idle'
  | 'preparing'
  | 'building'
  | 'firmware'
  | 'device'
  | 'flashing'
  | 'verifying'
  | 'serial'
  | 'resetting'
  | 'waiting'
  | 'complete'
  | 'failed';

export type RunStatus = 'success' | 'warning' | 'failed';

export interface RunProgress {
  readonly runId: number;
  readonly stage: RunStage;
  readonly message?: string;
}

export interface RunResult {
  readonly runId: number;
  readonly success: boolean;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly failedStage?: RunStage;
  readonly build?: BuildResult;
  readonly firmwarePath?: string;
  readonly flash?: FlashResult;
  readonly reset?: ResetResult;
  readonly serialConnected: boolean;
  readonly serialPort?: string;
  readonly readyCheckEnabled: boolean;
  readonly readyDetected?: boolean;
  readonly readyPattern?: string;
  readonly readyElapsedMs?: number;
  readonly warnings: readonly string[];
  readonly error?: string;
}

export interface RunSerialSettings {
  readonly serialPort: string;
  readonly baudRate: number;
  readonly dataBits: SerialConfiguration['dataBits'];
  readonly stopBits: SerialConfiguration['stopBits'];
  readonly parity: SerialConfiguration['parity'];
}

export interface RunSerialService {
  listSerialPorts(): Promise<readonly SerialPortInfo[]>;
  connectSerial(
    configuration: SerialConfiguration,
  ): Promise<SerialOperationResult>;
  getSerialStatus(): SerialStatus;
  clearSerialLog(): SerialOperationResult;
  waitSerial(
    pattern: string,
    timeoutMs: number,
    options?: SerialWaitOptions,
  ): Promise<SerialWaitResult>;
}

export interface FirmwareValidationResult {
  readonly success: boolean;
  readonly firmwarePath?: string;
  readonly error?: string;
}

export interface RunCoreDependencies {
  readonly buildProject: (
    project: Stm32ProjectInfo,
    options: BuildOptions,
  ) => Promise<BuildResult>;
  readonly findFirmwareArtifact: (
    project: Stm32ProjectInfo,
  ) => Promise<string | undefined>;
  readonly validateFirmwareArtifact: (
    project: Stm32ProjectInfo,
    firmwarePath: string,
    completedAt: number,
  ) => Promise<FirmwareValidationResult>;
  readonly getDeviceStatus: (
    programmerExecutable?: string,
  ) => Promise<DeviceStatus>;
  readonly flashFirmware: (
    project: Stm32ProjectInfo,
    options: FlashOptions,
  ) => Promise<FlashResult>;
  readonly resetTarget: (options: ResetOptions) => Promise<ResetResult>;
}

export interface BuildAndRunOptions {
  readonly project: Stm32ProjectInfo;
  readonly cmakeExecutable?: string;
  readonly programmerExecutable?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly verify?: boolean;
  readonly serial?: RunSerialService;
  readonly serialSettings?: RunSerialSettings;
  readonly waitForSerialReady?: boolean;
  readonly readyPattern?: string;
  readonly readyTimeoutMs?: number;
  readonly clearSerialBeforeRun?: boolean;
  readonly operationLock?: OperationLock;
  /** A run lease acquired by a Controller before UI-specific preparation. */
  readonly operationLease?: OperationLease;
  readonly dependencies?: Partial<RunCoreDependencies>;
  readonly onProgress?: (progress: RunProgress) => void;
  readonly onBuildOutput?: (event: BuildOutputEvent) => void;
  readonly onProgrammerOutput?: (event: ProgrammerOutputEvent) => void;
}

export type Dockyard32Operation = 'run' | 'build' | 'flash' | 'reset';

export interface OperationLease {
  readonly operation: Dockyard32Operation;
  release(): void;
}

export interface OperationLock {
  acquire(operation: Dockyard32Operation): OperationLease | undefined;
  getActiveOperation(): Dockyard32Operation | undefined;
}
