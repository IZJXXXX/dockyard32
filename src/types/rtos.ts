export type RtosKernel = 'freertos' | 'threadx' | 'zephyr';

export type RtosDetectionConfidence =
  | 'exact'
  | 'high'
  | 'inferred'
  | 'unknown';

export type CmsisRtosWrapper = 'v1' | 'v2';

export interface RtosDetectionResult {
  readonly detected: boolean;
  readonly kernel?: RtosKernel;
  readonly version?: string;
  readonly cmsisWrapper?: CmsisRtosWrapper;
  readonly confidence: RtosDetectionConfidence;
  readonly evidence: readonly string[];
  readonly warnings: readonly string[];
  readonly elfPath?: string;
}

export type RtosTaskState =
  | 'running'
  | 'ready'
  | 'pending-ready'
  | 'blocked'
  | 'suspended'
  | 'deleted'
  | 'unknown';

export interface RtosTask {
  readonly id: number;
  readonly address: number;
  readonly name: string;
  readonly state: RtosTaskState;
  readonly priority: number;
  readonly basePriority?: number;
  readonly stackPointer?: number;
  readonly stackBase?: number;
  readonly stackEnd?: number;
  readonly stackFreeBytes?: number;
  readonly stackTotalBytes?: number;
  readonly stackUsedPercent?: number;
  readonly runtimeCounter?: number;
  readonly runtimePercent?: number;
}

export type RtosObjectType =
  | 'queue'
  | 'mutex'
  | 'recursive-mutex'
  | 'binary-semaphore'
  | 'counting-semaphore'
  | 'queue-set'
  | 'unknown';

export interface RtosKernelObject {
  readonly address: number;
  readonly name: string;
  readonly type: RtosObjectType;
  readonly messagesWaiting: number;
  readonly length: number;
  readonly itemSize: number;
  readonly holderTaskAddress?: number;
  readonly waitingToSendTaskAddresses: readonly number[];
  readonly waitingToReceiveTaskAddresses: readonly number[];
}

export type RtosRelationKind =
  | 'waits-to-receive'
  | 'waits-to-send'
  | 'waits-for-mutex'
  | 'holds';

export interface RtosRelation {
  readonly taskAddress: number;
  readonly objectAddress: number;
  readonly kind: RtosRelationKind;
}

export interface RtosSnapshot {
  readonly success: boolean;
  readonly kernel: RtosKernel;
  readonly capturedAt: number;
  readonly tasks: readonly RtosTask[];
  readonly objects: readonly RtosKernelObject[];
  readonly relations: readonly RtosRelation[];
  readonly currentTaskAddress?: number;
  readonly warnings: readonly string[];
  readonly targetResumed: boolean;
  readonly error?: string;
}

export interface RtosDebugTools {
  readonly gdbExecutable?: string;
  readonly gdbServerExecutable?: string;
  readonly programmerExecutable?: string;
}

export interface RtosCaptureOptions extends RtosDebugTools {
  readonly elfPath: string;
  readonly probeSerialNumber?: string;
  readonly serverStartupTimeoutMs?: number;
  readonly captureTimeoutMs?: number;
  readonly terminateGraceMs?: number;
  readonly onOutput?: (text: string) => void;
}
