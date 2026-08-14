import { spawn } from 'node:child_process';

export interface ProcessOutputEvent {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface ProcessResult {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError?: NodeJS.ErrnoException;
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly onOutput?: (event: ProcessOutputEvent) => void;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onOutput?.({ stream: 'stdout', text });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onOutput?.({ stream: 'stderr', text });
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
        resolve({ exitCode: exitCode ?? undefined, stdout, stderr });
      }
    });
  });
}
