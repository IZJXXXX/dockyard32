import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { RunResult } from '../types/run';

const LAST_RUN_FILE = '.dockyard32-last-run.json';
const LEGACY_LAST_RUN_FILE = '.stm32-workbench-last-run.json';

export async function writeLastRunResult(
  workspacePath: string,
  result: RunResult,
): Promise<void> {
  const directory = path.join(workspacePath, '.vscode');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, LAST_RUN_FILE),
    `${JSON.stringify(result, undefined, 2)}\n`,
    'utf8',
  );
}

export async function readLastRunResult(
  workspacePath: string,
): Promise<RunResult | undefined> {
  for (const fileName of [LAST_RUN_FILE, LEGACY_LAST_RUN_FILE]) {
    try {
      const text = await fs.readFile(
        path.join(workspacePath, '.vscode', fileName),
        'utf8',
      );
      const value: unknown = JSON.parse(text);
      if (isRunResult(value)) {
        return value;
      }
    } catch {
      // Try the current or legacy last-run file.
    }
  }
  return undefined;
}

function isRunResult(value: unknown): value is RunResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.runId) &&
    typeof record.success === 'boolean' &&
    typeof record.status === 'string' &&
    typeof record.startedAt === 'number' &&
    typeof record.completedAt === 'number' &&
    typeof record.durationMs === 'number' &&
    typeof record.serialConnected === 'boolean' &&
    typeof record.readyCheckEnabled === 'boolean' &&
    Array.isArray(record.warnings)
  );
}
