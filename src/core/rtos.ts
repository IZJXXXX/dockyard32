import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { runCommand } from './process';
import type { Stm32ProjectInfo } from '../types/project';
import type {
  CmsisRtosWrapper,
  RtosDetectionConfidence,
  RtosDetectionResult,
  RtosKernel,
} from '../types/rtos';

const MAX_SCAN_FILES = 12_000;
const MAX_BUILD_SCAN_FILES = 5_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.svn', '.hg', 'node_modules', 'build', 'out', 'Debug', 'Release',
]);
const RELEVANT_FILE_NAMES = new Set([
  'freertos.h',
  'freertosconfig.h',
  'task.c',
  'queue.c',
  'cmsis_os.c',
  'cmsis_os.h',
  'cmsis_os2.c',
  'cmsis_os2.h',
  'tx_api.h',
  'tx_thread.c',
  'kernel.h',
  'prj.conf',
]);

export interface DetectRtosOptions {
  readonly mode?: 'auto' | 'off' | RtosKernel;
  readonly nmExecutable?: string;
  readonly elfPath?: string;
}

interface StaticEvidence {
  readonly kernel: RtosKernel;
  readonly weight: number;
  readonly label: string;
}

export async function detectRtos(
  project: Stm32ProjectInfo,
  options: DetectRtosOptions = {},
): Promise<RtosDetectionResult> {
  if (options.mode === 'off' || project.detected !== true || project.projectRoot === undefined) {
    return noRtos();
  }

  const evidence = await collectStaticEvidence(project.projectRoot);
  const forcedKernel = options.mode !== undefined && options.mode !== 'auto'
    ? options.mode
    : undefined;
  const scores = scoreEvidence(evidence);
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  const staticKernel = forcedKernel ?? ranked[0]?.[0];
  const staticScore = staticKernel === undefined ? 0 : scores.get(staticKernel) ?? 0;
  const warnings: string[] = [];
  if (
    forcedKernel === undefined &&
    ranked.length > 1 &&
    ranked[0] !== undefined &&
    ranked[1] !== undefined &&
    ranked[0][1] === ranked[1][1]
  ) {
    warnings.push('Multiple RTOS kernels have equally strong project evidence');
  }

  const firmware = options.elfPath ?? await findElfArtifact(project);
  const elfConfirmation = firmware === undefined || options.nmExecutable === undefined
    ? undefined
    : await confirmRtosFromElf(firmware, options.nmExecutable);
  const kernel = elfConfirmation?.kernel ?? staticKernel;
  if (
    kernel === undefined ||
    (forcedKernel === undefined && staticScore < 20 && elfConfirmation === undefined)
  ) {
    return {
      ...noRtos(),
      evidence: evidence.map((item) => item.label),
      warnings,
      elfPath: firmware,
    };
  }
  if (
    elfConfirmation !== undefined &&
    staticKernel !== undefined &&
    staticKernel !== elfConfirmation.kernel
  ) {
    warnings.push(
      `Project files suggest ${staticKernel}, but ELF symbols confirm ${elfConfirmation.kernel}`,
    );
  }

  const selectedEvidence = evidence
    .filter((item) => item.kernel === kernel)
    .map((item) => item.label);
  if (elfConfirmation !== undefined) {
    selectedEvidence.push(...elfConfirmation.evidence);
  }
  const version = kernel === 'freertos'
    ? await detectFreeRtosVersion(project.projectRoot)
    : undefined;
  return {
    detected: true,
    kernel,
    version,
    cmsisWrapper: cmsisWrapper(evidence),
    confidence: elfConfirmation === undefined
      ? confidenceForScore(staticScore, forcedKernel !== undefined)
      : 'exact',
    evidence: unique(selectedEvidence),
    warnings,
    elfPath: firmware,
  };
}

export async function findElfArtifact(
  project: Stm32ProjectInfo,
): Promise<string | undefined> {
  if (project.buildDir === undefined) {
    return undefined;
  }
  const candidates: Array<{
    readonly filePath: string;
    readonly nameMatch: boolean;
    readonly modifiedAt: number;
  }> = [];
  let scanned = 0;
  async function visit(directory: string): Promise<void> {
    if (scanned >= MAX_BUILD_SCAN_FILES) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_BUILD_SCAN_FILES || entry.isSymbolicLink()) {
        continue;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || !['.elf', '.axf', '.out'].includes(extension)) {
        continue;
      }
      const stats = await fs.stat(candidate);
      candidates.push({
        filePath: candidate,
        nameMatch: path.basename(entry.name, extension).toLowerCase() ===
          project.projectName?.toLowerCase(),
        modifiedAt: stats.mtimeMs,
      });
    }
  }
  await visit(project.buildDir);
  candidates.sort((left, right) =>
    Number(right.nameMatch) - Number(left.nameMatch) ||
    right.modifiedAt - left.modifiedAt ||
    left.filePath.localeCompare(right.filePath));
  return candidates[0]?.filePath;
}

export async function confirmRtosFromElf(
  elfPath: string,
  nmExecutable: string,
): Promise<{ readonly kernel: RtosKernel; readonly evidence: string[] } | undefined> {
  const result = await runCommand(nmExecutable, ['-a', elfPath]);
  if (result.spawnError !== undefined || result.exitCode !== 0) {
    return undefined;
  }
  const symbols = `${result.stdout}\n${result.stderr}`;
  if (/\bpxCurrentTCB\b/u.test(symbols) && /\buxCurrentNumberOfTasks\b/u.test(symbols)) {
    return {
      kernel: 'freertos',
      evidence: ['ELF:pxCurrentTCB', 'ELF:uxCurrentNumberOfTasks'],
    };
  }
  if (/\b_tx_thread_current_ptr\b/u.test(symbols)) {
    return { kernel: 'threadx', evidence: ['ELF:_tx_thread_current_ptr'] };
  }
  if (/\b_kernel\b/u.test(symbols) && /\bz_thread_/u.test(symbols)) {
    return { kernel: 'zephyr', evidence: ['ELF:_kernel', 'ELF:z_thread_*'] };
  }
  return undefined;
}

async function collectStaticEvidence(projectRoot: string): Promise<StaticEvidence[]> {
  const evidence: StaticEvidence[] = [];
  let visited = 0;

  async function visit(directory: string): Promise<void> {
    if (visited >= MAX_SCAN_FILES) {
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_SCAN_FILES) {
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await visit(path.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const lowerName = entry.name.toLowerCase();
      const filePath = path.join(directory, entry.name);
      if (lowerName === 'freertosconfig.h') {
        evidence.push({ kernel: 'freertos', weight: 45, label: 'FreeRTOSConfig.h' });
      } else if (lowerName === 'tx_api.h') {
        evidence.push({ kernel: 'threadx', weight: 45, label: 'ThreadX tx_api.h' });
      } else if (lowerName === 'tx_thread.c') {
        evidence.push({ kernel: 'threadx', weight: 30, label: 'ThreadX tx_thread.c' });
      }
      if (
        RELEVANT_FILE_NAMES.has(lowerName) ||
        lowerName.endsWith('.ioc') ||
        lowerName === 'cmakelists.txt'
      ) {
        await inspectRelevantText(filePath, lowerName, evidence);
      }
    }
  }

  await visit(projectRoot);
  return deduplicateEvidence(evidence);
}

async function inspectRelevantText(
  filePath: string,
  lowerName: string,
  evidence: StaticEvidence[],
): Promise<void> {
  let contents: string;
  try {
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_TEXT_BYTES) {
      return;
    }
    contents = await fs.readFile(filePath, 'utf8');
  } catch {
    return;
  }
  if (/\bFREERTOS\b|FreeRTOS\.h|xTaskCreate|osThreadCreate|osThreadNew/u.test(contents)) {
    evidence.push({
      kernel: 'freertos',
      weight: lowerName.endsWith('.ioc') ? 40 : 12,
      label: lowerName.endsWith('.ioc') ? '.ioc FreeRTOS middleware' : `${lowerName}:FreeRTOS API`,
    });
  }
  if (/\b(?:THREADX|AZRTOS)\b|tx_thread_create|#\s*include\s*[<"]tx_api\.h/u.test(contents)) {
    evidence.push({
      kernel: 'threadx',
      weight: lowerName.endsWith('.ioc') ? 40 : 12,
      label: lowerName.endsWith('.ioc') ? '.ioc ThreadX middleware' : `${lowerName}:ThreadX API`,
    });
  }
  if (
    /CONFIG_(?:THREAD_MONITOR|MULTITHREADING)\s*=\s*y|#\s*include\s*[<"]zephyr\/kernel\.h|find_package\s*\(\s*Zephyr/iu.test(
      contents,
    )
  ) {
    evidence.push({ kernel: 'zephyr', weight: 25, label: `${lowerName}:Zephyr kernel` });
  }
  if (lowerName === 'cmsis_os.c' || lowerName === 'cmsis_os.h') {
    evidence.push({ kernel: 'freertos', weight: 8, label: 'CMSIS-RTOS v1 wrapper' });
  }
  if (lowerName === 'cmsis_os2.c' || lowerName === 'cmsis_os2.h') {
    evidence.push({ kernel: 'freertos', weight: 8, label: 'CMSIS-RTOS v2 wrapper' });
  }
}

async function detectFreeRtosVersion(projectRoot: string): Promise<string | undefined> {
  let visited = 0;
  async function visit(directory: string): Promise<string | undefined> {
    if (visited >= MAX_SCAN_FILES) {
      return undefined;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
        const version = await visit(path.join(directory, entry.name));
        if (version !== undefined) {
          return version;
        }
      } else if (
        entry.isFile() &&
        ['freertos.h', 'task.h'].includes(entry.name.toLowerCase())
      ) {
        try {
          const contents = await fs.readFile(path.join(directory, entry.name), 'utf8');
          const match = /tskKERNEL_VERSION_NUMBER\s+"V?([^"\s]+)"/u.exec(contents);
          if (match?.[1] !== undefined) {
            return match[1];
          }
        } catch {
          // Keep scanning other candidate headers.
        }
      }
    }
    return undefined;
  }
  return visit(projectRoot);
}

function scoreEvidence(evidence: readonly StaticEvidence[]): Map<RtosKernel, number> {
  const scores = new Map<RtosKernel, number>();
  for (const item of evidence) {
    scores.set(item.kernel, (scores.get(item.kernel) ?? 0) + item.weight);
  }
  return scores;
}

function confidenceForScore(score: number, forced: boolean): RtosDetectionConfidence {
  if (score >= 60) {
    return 'high';
  }
  if (forced) {
    return 'inferred';
  }
  return score >= 20 ? 'inferred' : 'unknown';
}

function cmsisWrapper(evidence: readonly StaticEvidence[]): CmsisRtosWrapper | undefined {
  if (evidence.some((item) => item.label === 'CMSIS-RTOS v2 wrapper')) {
    return 'v2';
  }
  return evidence.some((item) => item.label === 'CMSIS-RTOS v1 wrapper')
    ? 'v1'
    : undefined;
}

function deduplicateEvidence(evidence: readonly StaticEvidence[]): StaticEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.kernel}:${item.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function noRtos(): RtosDetectionResult {
  return {
    detected: false,
    confidence: 'unknown',
    evidence: [],
    warnings: [],
  };
}
