export type BuildSystem = 'cmake' | 'mdk' | 'unknown';

export type McuDetectionConfidence = 'exact' | 'inferred' | 'unknown';

export type McuDetectionSource = 'ioc' | 'linker-script' | 'startup';

export interface MdkProjectConfiguration {
  readonly projectFile: string;
  readonly targetName?: string;
  readonly device?: string;
  readonly outputDirectory?: string;
  readonly outputName?: string;
}

export interface Stm32ProjectInfo {
  readonly detected: boolean;
  readonly workspacePath?: string;
  readonly projectRoot?: string;
  readonly projectName?: string;
  readonly iocPath?: string;
  readonly mcu?: string;
  readonly family?: string;
  readonly mcuDetection: McuDetectionConfidence;
  readonly mcuSource?: McuDetectionSource;
  readonly buildSystem: BuildSystem;
  readonly buildDir?: string;
  readonly configurePreset?: string;
  readonly buildPreset?: string;
  readonly mdk?: MdkProjectConfiguration;
  readonly evidence: readonly string[];
  readonly reason?: 'no-workspace' | 'not-stm32';
}
