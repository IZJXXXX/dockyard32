export type ProgrammerStage = 'flash' | 'reset';

export interface ProgrammerOutputEvent {
  readonly stage: ProgrammerStage;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface FlashOptions {
  readonly programmerExecutable?: string;
  readonly firmwarePath?: string;
  readonly verify?: boolean;
  readonly reset?: boolean;
  readonly onOutput?: (event: ProgrammerOutputEvent) => void;
}

export interface ResetOptions {
  readonly programmerExecutable?: string;
  readonly onOutput?: (event: ProgrammerOutputEvent) => void;
}

export interface FlashResult {
  readonly success: boolean;
  readonly stage: 'flash';
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly firmwarePath?: string;
  readonly chip?: string;
  readonly verify: boolean;
  readonly reset: boolean;
  readonly error?: string;
}

export interface ResetResult {
  readonly success: boolean;
  readonly stage: 'reset';
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly chip?: string;
  readonly error?: string;
}
