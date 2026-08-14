export type WorkbenchProgressOperation = 'build' | 'flash' | 'run' | 'reset';

export type WorkbenchProgressStatus =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface WorkbenchProgress {
  readonly operation?: WorkbenchProgressOperation;
  readonly status: WorkbenchProgressStatus;
  readonly stage: string;
  readonly message: string;
  readonly percent: number;
}

export type WorkbenchProgressReporter = (
  progress: WorkbenchProgress,
) => void;
