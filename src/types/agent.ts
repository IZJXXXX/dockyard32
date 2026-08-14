import type { BuildResult } from './build';
import type { FlashResult, ResetResult } from './flash';
import type { RunResult } from './run';
import type { SerialStatus, SerialWaitResult } from './serial';

export type AgentErrorCode =
  | 'NO_WORKSPACE'
  | 'NOT_STM32_PROJECT'
  | 'CMAKE_NOT_FOUND'
  | 'BUILD_FAILED'
  | 'FIRMWARE_NOT_FOUND'
  | 'PROGRAMMER_NOT_FOUND'
  | 'STLINK_NOT_CONNECTED'
  | 'MULTIPLE_STLINK_PROBES'
  | 'FLASH_FAILED'
  | 'VERIFY_FAILED'
  | 'RESET_FAILED'
  | 'SERIAL_NOT_CONNECTED'
  | 'SERIAL_PORT_NOT_FOUND'
  | 'SERIAL_PORT_AMBIGUOUS'
  | 'SERIAL_WRITE_FAILED'
  | 'SERIAL_WAIT_TIMEOUT'
  | 'SERIAL_OWNED_BY_EXTENSION'
  | 'OPERATION_BUSY'
  | 'OPERATION_TIMEOUT'
  | 'INVALID_ARGUMENT'
  | 'NO_LAST_RUN'
  | 'INTERNAL_ERROR';

export interface AgentError {
  readonly code: AgentErrorCode;
  readonly message: string;
  readonly stage?: string;
}

export type AgentResult<T> =
  | {
      readonly success: true;
      readonly data: T;
      readonly warnings?: readonly string[];
    }
  | {
      readonly success: false;
      readonly data?: T;
      readonly error: AgentError;
      readonly warnings?: readonly string[];
    };

export interface AgentProjectInfo {
  readonly projectName?: string;
  readonly workspacePath: string;
  readonly projectRoot?: string;
  readonly mcu?: string;
  readonly family?: string;
  readonly buildSystem: string;
  readonly buildDir?: string;
  readonly configurePreset?: string;
  readonly buildPreset?: string;
  readonly iocPath?: string;
}

export interface AgentToolInfo {
  readonly found: boolean;
  readonly path?: string;
  readonly source?: string;
}

export interface AgentToolStatus {
  readonly cmake: AgentToolInfo;
  readonly ninja: AgentToolInfo;
  readonly armGcc: AgentToolInfo;
  readonly programmer: AgentToolInfo;
  readonly detectedAt: number;
}

export interface AgentProbeInfo {
  readonly connected: boolean;
  readonly count: number;
  readonly serialNumber?: string;
  readonly firmware?: string;
  readonly board?: string;
  readonly targetMcu?: string;
}

export interface AgentSerialLog {
  readonly lineCount: number;
  readonly truncated: boolean;
  readonly text: string;
}

export type SerialLineEnding = 'none' | 'lf' | 'cr' | 'crlf';

export interface AgentSendSerialInput {
  readonly text: string;
  readonly lineEnding?: SerialLineEnding;
}

export interface AgentWaitSerialInput {
  readonly pattern: string;
  readonly timeoutMs?: number;
}

export interface AgentApi {
  getProjectInfo(): Promise<AgentResult<AgentProjectInfo>>;
  getToolStatus(): Promise<AgentResult<AgentToolStatus>>;
  getProbeInfo(): Promise<AgentResult<AgentProbeInfo>>;
  getSerialStatus(): Promise<AgentResult<SerialStatus>>;
  getSerialLog(maxLines?: number): Promise<AgentResult<AgentSerialLog>>;
  getLastRun(): Promise<AgentResult<RunResult>>;
  build(): Promise<AgentResult<BuildResult>>;
  flash(): Promise<AgentResult<FlashResult>>;
  reset(): Promise<AgentResult<ResetResult>>;
  buildAndRun(): Promise<AgentResult<RunResult>>;
  sendSerial(input: AgentSendSerialInput): Promise<AgentResult<SerialStatus>>;
  waitSerial(input: AgentWaitSerialInput): Promise<AgentResult<SerialWaitResult>>;
}
