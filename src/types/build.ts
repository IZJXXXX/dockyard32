export type BuildStage = 'configure' | 'build' | 'mirror';

export type DiagnosticSeverity = 'error' | 'warning';

export interface BuildDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
}

export interface BuildResult {
  readonly success: boolean;
  readonly stage: BuildStage;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly errors: readonly BuildDiagnostic[];
  readonly warnings: readonly BuildDiagnostic[];
}

export interface BuildOutputEvent {
  readonly stage: BuildStage;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface BuildOptions {
  readonly cmakeExecutable?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly forceConfigure?: boolean;
  readonly onStage?: (stage: BuildStage) => void;
  readonly onOutput?: (event: BuildOutputEvent) => void;
}
