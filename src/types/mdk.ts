import type { BuildDiagnostic, BuildResult } from './build';

export interface MdkMemoryRegion {
  readonly origin: string;
  readonly length: string;
}

export interface MdkTargetInfo {
  readonly name: string;
  readonly device?: string;
  readonly outputDirectory?: string;
  readonly outputName?: string;
  readonly createHexFile: boolean;
  readonly sources: readonly string[];
  readonly includePaths: readonly string[];
  readonly defines: readonly string[];
  readonly scatterFile?: string;
  readonly libraries: readonly string[];
  readonly compiler: 'armcc5' | 'armclang6' | 'unknown';
  readonly flash?: MdkMemoryRegion;
  readonly ram?: MdkMemoryRegion;
  readonly ccmRam?: MdkMemoryRegion;
}

export interface ParsedMdkProject {
  readonly projectFile: string;
  readonly targets: readonly MdkTargetInfo[];
}

export interface MdkExportResult {
  readonly success: boolean;
  readonly projectFile?: string;
  readonly warnings: readonly string[];
  readonly error?: string;
}

export interface MdkExportOptions {
  readonly destinationDirectory?: string;
  readonly device?: string;
}

export interface MdkImportOptions {
  readonly destinationDirectory: string;
  readonly sourceRoot?: string;
  readonly targetName?: string;
  readonly device?: string;
}

export interface MdkImportPreviewOptions {
  readonly sourceRoot?: string;
  readonly targetName?: string;
  readonly device?: string;
}

export interface MdkImportPreview {
  readonly success: boolean;
  readonly targetName?: string;
  readonly device?: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly externalFileCount: number;
  readonly externalDirectories: readonly string[];
  readonly externalDirectoryCount: number;
  readonly error?: string;
}

export interface MdkImportResult {
  readonly success: boolean;
  readonly projectDirectory?: string;
  readonly cmakeFile?: string;
  readonly sourceProjectFile?: string;
  readonly copiedFiles: number;
  readonly convertedFiles: readonly string[];
  readonly warnings: readonly string[];
  readonly error?: string;
}

export type { BuildDiagnostic, BuildResult };
