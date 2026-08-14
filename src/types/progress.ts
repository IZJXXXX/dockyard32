export type Dockyard32ProgressOperation = 'build' | 'flash' | 'run' | 'reset';

export type Dockyard32ProgressStatus =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface Dockyard32Progress {
  readonly operation?: Dockyard32ProgressOperation;
  readonly status: Dockyard32ProgressStatus;
  readonly stage: string;
  readonly message: string;
  readonly percent: number;
}

export type Dockyard32ProgressReporter = (
  progress: Dockyard32Progress,
) => void;
