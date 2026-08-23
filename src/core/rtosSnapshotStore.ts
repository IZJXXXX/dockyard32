import * as path from 'node:path';

import type { RtosKernel, RtosSnapshot } from '../types/rtos';

export interface RtosSnapshotContext {
  readonly workspacePath?: string;
  readonly kernel?: RtosKernel;
  readonly elfPath?: string;
}

export interface RtosSnapshotToken {
  readonly key: string;
  readonly revision: number;
}

export class RtosSnapshotStore {
  private contextKey = contextKey({});
  private revision = 0;
  private snapshot?: RtosSnapshot;

  public updateContext(context: RtosSnapshotContext): boolean {
    const nextKey = contextKey(context);
    if (nextKey === this.contextKey) {
      return false;
    }
    this.contextKey = nextKey;
    this.invalidate();
    return true;
  }

  public clear(): void {
    this.invalidate();
  }

  public token(): RtosSnapshotToken {
    return { key: this.contextKey, revision: this.revision };
  }

  public commit(token: RtosSnapshotToken, snapshot: RtosSnapshot): boolean {
    if (token.key !== this.contextKey || token.revision !== this.revision) {
      return false;
    }
    this.snapshot = snapshot;
    return true;
  }

  public get(): RtosSnapshot | undefined {
    return this.snapshot;
  }

  private invalidate(): void {
    this.revision += 1;
    this.snapshot = undefined;
  }
}

function contextKey(context: RtosSnapshotContext): string {
  return JSON.stringify({
    workspacePath: normalizePath(context.workspacePath),
    kernel: context.kernel ?? '',
    elfPath: normalizePath(context.elfPath),
  });
}

function normalizePath(value: string | undefined): string {
  return value === undefined || value.length === 0 ? '' : path.resolve(value);
}
