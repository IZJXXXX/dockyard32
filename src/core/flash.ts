import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { runCommand } from './process';
import type {
  FlashOptions,
  FlashResult,
  ResetOptions,
  ResetResult,
} from '../types/flash';
import type { Stm32ProjectInfo } from '../types/project';

const FIRMWARE_EXTENSIONS = new Set(['.elf', '.axf', '.out', '.hex']);
const MAX_SCANNED_ENTRIES = 5_000;

interface FirmwareCandidate {
  readonly filePath: string;
  readonly extensionPriority: number;
  readonly nameMatch: boolean;
  readonly modifiedAt: number;
}

export async function findFirmwareArtifact(
  projectInfo: Stm32ProjectInfo,
): Promise<string | undefined> {
  if (projectInfo.buildDir === undefined) {
    return undefined;
  }

  const candidates: FirmwareCandidate[] = [];
  const projectName = projectInfo.projectName?.toLowerCase();
  let scannedEntries = 0;

  async function visit(directory: string): Promise<void> {
    if (scannedEntries >= MAX_SCANNED_ENTRIES) {
      return;
    }

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_SCANNED_ENTRIES) {
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || !FIRMWARE_EXTENSIONS.has(extension)) {
        continue;
      }
      const stats = await fs.stat(filePath);
      candidates.push({
        filePath,
        extensionPriority: extension === '.elf' ? 3 : extension === '.hex' ? 2 : 1,
        nameMatch:
          projectName !== undefined &&
          path.basename(entry.name, extension).toLowerCase() === projectName,
        modifiedAt: stats.mtimeMs,
      });
    }
  }

  await visit(projectInfo.buildDir);
  candidates.sort(
    (left, right) =>
      Number(right.nameMatch) - Number(left.nameMatch) ||
      right.extensionPriority - left.extensionPriority ||
      right.modifiedAt - left.modifiedAt ||
      left.filePath.localeCompare(right.filePath),
  );
  return candidates[0]?.filePath;
}

export async function flashFirmware(
  projectInfo: Stm32ProjectInfo,
  options: FlashOptions = {},
): Promise<FlashResult> {
  const startTime = Date.now();
  const verify = options.verify ?? true;
  const reset = options.reset ?? false;
  const programmer = options.programmerExecutable;
  if (programmer === undefined) {
    return flashFailure(
      'STM32CubeProgrammer CLI not found',
      verify,
      reset,
      startTime,
    );
  }

  const firmwarePath = options.firmwarePath ?? (await findFirmwareArtifact(projectInfo));
  if (firmwarePath === undefined) {
    return flashFailure(
      'No ELF or HEX firmware found in the build directory',
      verify,
      reset,
      startTime,
    );
  }

  try {
    if (!(await fs.stat(firmwarePath)).isFile()) {
      return flashFailure('Firmware file not found', verify, reset, startTime);
    }
  } catch {
    return flashFailure('Firmware file not found', verify, reset, startTime);
  }

  const args = ['-c', 'port=SWD', '-w', firmwarePath];
  if (verify) {
    args.push('-v');
  }
  if (reset) {
    args.push('-rst');
  }

  const result = await runCommand(programmer, args, {
    cwd: projectInfo.projectRoot,
    onOutput: (event) =>
      options.onOutput?.({ stage: 'flash', ...event }),
  });
  const error = programmerError(result, 'Flash failed');
  return {
    success: result.spawnError === undefined && result.exitCode === 0,
    stage: 'flash',
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - startTime,
    firmwarePath,
    chip: parseConnectedChip(`${result.stdout}\n${result.stderr}`),
    verify,
    reset,
    error,
  };
}

export async function resetTarget(
  options: ResetOptions = {},
): Promise<ResetResult> {
  const startTime = Date.now();
  const programmer = options.programmerExecutable;
  if (programmer === undefined) {
    return {
      success: false,
      stage: 'reset',
      stdout: '',
      stderr: '',
      durationMs: Date.now() - startTime,
      error: 'STM32CubeProgrammer CLI not found',
    };
  }

  const result = await runCommand(programmer, ['-c', 'port=SWD', '-rst'], {
    onOutput: (event) => options.onOutput?.({ stage: 'reset', ...event }),
  });
  return {
    success: result.spawnError === undefined && result.exitCode === 0,
    stage: 'reset',
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - startTime,
    chip: parseConnectedChip(`${result.stdout}\n${result.stderr}`),
    error: programmerError(result, 'Reset failed'),
  };
}

export function parseConnectedChip(output: string): string | undefined {
  const normalized = stripAnsi(output);
  const patterns = [
    /^(?:device\s+name|device)\s*:\s*(STM32\S+)/imu,
    /\b(STM32[A-Z0-9]{3,})\b/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match?.[1] !== undefined) {
      return match[1].toUpperCase();
    }
  }
  return undefined;
}

function stripAnsi(value: string): string {
  const escape = String.fromCodePoint(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'gu'), '');
}

function programmerError(
  result: Awaited<ReturnType<typeof runCommand>>,
  fallback: string,
): string | undefined {
  if (result.spawnError !== undefined) {
    return result.spawnError.code === 'ENOENT'
      ? 'STM32CubeProgrammer CLI not found'
      : result.spawnError.message;
  }
  if (result.exitCode === 0) {
    return undefined;
  }
  return `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? fallback;
}

function flashFailure(
  error: string,
  verify: boolean,
  reset: boolean,
  startTime: number,
): FlashResult {
  return {
    success: false,
    stage: 'flash',
    stdout: '',
    stderr: '',
    durationMs: Date.now() - startTime,
    verify,
    reset,
    error,
  };
}
