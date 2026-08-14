import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type {
  BuildDiagnostic,
  BuildOptions,
  BuildResult,
  BuildStage,
} from '../types/build';
import type { Stm32ProjectInfo } from '../types/project';

interface ProcessResult {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: NodeJS.ErrnoException;
}

let latestDiagnostics: readonly BuildDiagnostic[] = [];

export async function buildProject(
  projectInfo: Stm32ProjectInfo,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const startTime = Date.now();
  if (projectInfo.buildSystem === 'mdk') {
    return finishResult({
      success: false,
      stage: 'configure',
      stdout: '',
      stderr: 'Keil MDK projects must be imported to a native macOS CMake project before building',
      durationMs: Date.now() - startTime,
      diagnostics: [createError(
        'Keil MDK projects must be imported to a native macOS CMake project before building',
      )],
    });
  }
  const cmakeExecutable = options.cmakeExecutable ?? 'cmake';
  const projectRoot = projectInfo.projectRoot;
  const buildDir = projectInfo.buildDir;

  if (
    !projectInfo.detected ||
    projectInfo.buildSystem !== 'cmake' ||
    projectRoot === undefined ||
    buildDir === undefined
  ) {
    return finishResult({
      success: false,
      stage: 'configure',
      stdout: '',
      stderr: 'CMake project not detected',
      durationMs: Date.now() - startTime,
      diagnostics: [createError('CMake project not detected')],
    });
  }

  let stdout = '';
  let stderr = '';
  const shouldConfigure =
    options.forceConfigure === true ||
    (await needsConfigure(projectRoot, buildDir));

  if (shouldConfigure) {
    options.onStage?.('configure');
    const configure = await runProcess(
      cmakeExecutable,
      projectInfo.configurePreset === undefined
        ? ['-S', projectRoot, '-B', buildDir]
        : ['--preset', projectInfo.configurePreset],
      projectRoot,
      'configure',
      options,
    );
    stdout += configure.stdout;
    stderr += configure.stderr;

    if (configure.spawnError !== undefined) {
      const message = executableError(cmakeExecutable, configure.spawnError);
      return finishResult({
        success: false,
        stage: 'configure',
        exitCode: configure.exitCode,
        stdout,
        stderr: appendLine(stderr, message),
        durationMs: Date.now() - startTime,
        diagnostics: [createError(message)],
      });
    }

    if (configure.exitCode !== 0) {
      return resultFromOutput(
        false,
        'configure',
        configure.exitCode,
        stdout,
        stderr,
        startTime,
      );
    }
  }

  options.onStage?.('build');
  const build = await runProcess(
    cmakeExecutable,
    projectInfo.buildPreset === undefined
      ? ['--build', buildDir]
      : ['--build', '--preset', projectInfo.buildPreset],
    projectRoot,
    'build',
    options,
  );
  stdout += build.stdout;
  stderr += build.stderr;

  if (build.spawnError !== undefined) {
    const message = executableError(cmakeExecutable, build.spawnError);
    return finishResult({
      success: false,
      stage: 'build',
      exitCode: build.exitCode,
      stdout,
      stderr: appendLine(stderr, message),
      durationMs: Date.now() - startTime,
      diagnostics: [createError(message)],
    });
  }

  return resultFromOutput(
    build.exitCode === 0,
    'build',
    build.exitCode,
    stdout,
    stderr,
    startTime,
  );
}

export function parseGccDiagnostics(output: string): BuildDiagnostic[] {
  const diagnostics: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  const pattern = /^(.*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.+)$/u;

  for (const rawLine of stripAnsi(output).split(/\r?\n/u)) {
    const match = pattern.exec(rawLine.trim());
    if (match === null) {
      continue;
    }

    const file = match[1]?.trim();
    const line = Number.parseInt(match[2] ?? '', 10);
    const column = match[3]
      ? Number.parseInt(match[3], 10)
      : undefined;
    const severity = match[4] === 'warning' ? 'warning' : 'error';
    const message = match[5]?.trim() ?? rawLine.trim();
    const key = `${severity}:${file}:${line}:${column ?? 0}:${message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    diagnostics.push({ severity, file, line, column, message });
  }

  return diagnostics;
}

export function getBuildDiagnostics(): readonly BuildDiagnostic[] {
  return latestDiagnostics.map((diagnostic) => ({ ...diagnostic }));
}

async function needsConfigure(
  projectRoot: string,
  buildDir: string,
): Promise<boolean> {
  const cachePath = path.join(buildDir, 'CMakeCache.txt');
  const cmakeListsPath = path.join(projectRoot, 'CMakeLists.txt');

  try {
    const [cache, cmakeLists] = await Promise.all([
      fs.stat(cachePath),
      fs.stat(cmakeListsPath),
    ]);
    return cmakeLists.mtimeMs > cache.mtimeMs;
  } catch {
    return true;
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  stage: BuildStage,
  options: BuildOptions,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, [...args], {
      cwd,
      env: {
        ...(options.env ?? process.env),
        CLICOLOR: '0',
        NO_COLOR: '1',
      },
      shell: false,
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onOutput?.({ stage, stream: 'stdout', text });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onOutput?.({ stage, stream: 'stderr', text });
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, spawnError: error });
      }
    });
    child.once('close', (exitCode) => {
      if (!settled) {
        settled = true;
        resolve({
          exitCode: exitCode ?? undefined,
          stdout,
          stderr,
        });
      }
    });
  });
}

function resultFromOutput(
  success: boolean,
  stage: BuildStage,
  exitCode: number | undefined,
  stdout: string,
  stderr: string,
  startTime: number,
): BuildResult {
  const diagnostics = parseGccDiagnostics(`${stdout}\n${stderr}`);
  if (!success && diagnostics.every((item) => item.severity !== 'error')) {
    diagnostics.push(createError(failureSummary(stage, stderr, stdout)));
  }
  return finishResult({
    success,
    stage,
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startTime,
    diagnostics,
  });
}

function finishResult(input: {
  readonly success: boolean;
  readonly stage: BuildStage;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly diagnostics: readonly BuildDiagnostic[];
}): BuildResult {
  latestDiagnostics = input.diagnostics.map((diagnostic) => ({ ...diagnostic }));
  return {
    success: input.success,
    stage: input.stage,
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    durationMs: input.durationMs,
    errors: latestDiagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    ),
    warnings: latestDiagnostics.filter(
      (diagnostic) => diagnostic.severity === 'warning',
    ),
  };
}

function executableError(
  executable: string,
  error: NodeJS.ErrnoException,
): string {
  return error.code === 'ENOENT'
    ? 'CMake executable not found'
    : `Unable to start ${executable}: ${error.message}`;
}

function createError(message: string): BuildDiagnostic {
  return { severity: 'error', message };
}

function failureSummary(
  stage: BuildStage,
  stderr: string,
  stdout: string,
): string {
  const lastLine = stripAnsi(`${stderr}\n${stdout}`)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  return lastLine ?? `${stage === 'configure' ? 'CMake configure' : 'Build'} failed`;
}

function appendLine(existing: string, line: string): string {
  return existing.length > 0 && !existing.endsWith('\n')
    ? `${existing}\n${line}`
    : `${existing}${line}`;
}

function stripAnsi(value: string): string {
  const escape = String.fromCodePoint(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'gu'), '');
}
