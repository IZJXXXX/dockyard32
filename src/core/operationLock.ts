import type {
  OperationLease,
  OperationLock,
  Dockyard32Operation,
} from '../types/run';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

interface LockRecord {
  readonly pid: number;
  readonly operation: Dockyard32Operation;
  readonly startedAt: number;
  readonly token: string;
}

export class Dockyard32OperationLock implements OperationLock {
  private active?: Dockyard32Operation;

  public constructor(
    private readonly workspacePath?: string | (() => string | undefined),
  ) {}

  public acquire(operation: Dockyard32Operation): OperationLease | undefined {
    if (this.active !== undefined) {
      return undefined;
    }
    const lockPath = this.resolveLockPath();
    const token = randomUUID();
    if (lockPath !== undefined && !acquireFileLock(lockPath, operation, token)) {
      return undefined;
    }
    this.active = operation;
    let released = false;
    return {
      operation,
      release: (): void => {
        if (!released && this.active === operation) {
          released = true;
          this.active = undefined;
          if (lockPath !== undefined) {
            releaseFileLock(lockPath, token);
          }
        }
      },
    };
  }

  public getActiveOperation(): Dockyard32Operation | undefined {
    if (this.active !== undefined) {
      return this.active;
    }
    const lockPath = this.resolveLockPath();
    return lockPath === undefined ? undefined : readActiveFileOperation(lockPath);
  }

  private resolveLockPath(): string | undefined {
    const workspace =
      typeof this.workspacePath === 'function'
        ? this.workspacePath()
        : this.workspacePath;
    if (workspace === undefined) {
      return undefined;
    }
    let canonicalWorkspace = workspace;
    try {
      canonicalWorkspace = realpathSync(workspace);
    } catch {
      // Acquisition will surface an invalid workspace path to the caller.
    }
    return path.join(
      canonicalWorkspace,
      '.vscode',
      '.dockyard32-operation.lock',
    );
  }
}

function acquireFileLock(
  lockPath: string,
  operation: Dockyard32Operation,
  token: string,
): boolean {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      try {
        const record: LockRecord = {
          pid: process.pid,
          operation,
          startedAt: Date.now(),
          token,
        };
        writeFileSync(descriptor, JSON.stringify(record), 'utf8');
      } finally {
        closeSync(descriptor);
      }
      return true;
    } catch (error: unknown) {
      if (!isFileExistsError(error) || !removeStaleLock(lockPath)) {
        return false;
      }
    }
  }
  return false;
}

function releaseFileLock(lockPath: string, token: string): void {
  const record = readLockRecord(lockPath);
  if (record?.token !== token) {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Another process may already have cleaned up an expired lock.
  }
}

function readActiveFileOperation(
  lockPath: string,
): Dockyard32Operation | undefined {
  const record = readLockRecord(lockPath);
  if (record === undefined) {
    return undefined;
  }
  if (!isProcessAlive(record.pid)) {
    removeStaleLock(lockPath);
    return undefined;
  }
  return record.operation;
}

function removeStaleLock(lockPath: string): boolean {
  const record = readLockRecord(lockPath);
  if (record !== undefined && isProcessAlive(record.pid)) {
    return false;
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function readLockRecord(lockPath: string): LockRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.pid !== 'number' ||
      !isDockyard32Operation(record.operation) ||
      typeof record.startedAt !== 'number' ||
      typeof record.token !== 'string'
    ) {
      return undefined;
    }
    return {
      pid: record.pid,
      operation: record.operation,
      startedAt: record.startedAt,
      token: record.token,
    };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isPermissionError(error);
  }
}

function isDockyard32Operation(value: unknown): value is Dockyard32Operation {
  return ['run', 'build', 'flash', 'reset'].includes(String(value));
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
}
