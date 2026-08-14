import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export async function validateConversionDestination(
  destination: string,
  allowNonEmpty = false,
): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(destination);
    return entries.length === 0 || allowNonEmpty
      ? undefined
      : 'The conversion destination is not empty';
  } catch (error: unknown) {
    return isNodeError(error) && error.code === 'ENOENT'
      ? undefined
      : `Unable to access the conversion destination: ${errorMessage(error)}`;
  }
}

export function validateProjectSourceRoot(
  sourceRoot: string,
  projectFile: string,
): string | undefined {
  const root = path.resolve(sourceRoot);
  const home = path.resolve(os.homedir());
  const filesystemRoot = path.parse(root).root;
  if (root === filesystemRoot || root === home || isInside(home, root)) {
    return 'Refusing to import from a broad system or home-directory root';
  }
  if (!isInside(path.resolve(projectFile), root)) {
    return 'The selected Keil project must be inside the selected source root';
  }
  return undefined;
}

export function validateSelectedInputDirectory(directory: string): string | undefined {
  const resolved = path.resolve(directory);
  const home = path.resolve(os.homedir());
  if (
    resolved === path.parse(resolved).root ||
    resolved === home ||
    isInside(home, resolved)
  ) {
    return `Refusing broad input directory: ${path.basename(resolved) || resolved}`;
  }
  return undefined;
}

export function reportPath(base: string, candidate: string | undefined): string | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  const relative = path.relative(base, candidate);
  return isContainedRelative(relative)
    ? normalizePath(relative || '.')
    : `<external>/${path.basename(candidate)}`;
}

export function isInside(candidate: string, parent: string): boolean {
  return isContainedRelative(path.relative(parent, candidate));
}

export async function removeLocalMetadataFiles(root: string): Promise<void> {
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      continue;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.name === '.DS_Store' || entry.name.startsWith('._')) {
        await fs.rm(candidate, { recursive: entry.isDirectory(), force: true });
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(candidate);
      }
    }
  }
}

export function isContainedRelative(relative: string): boolean {
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
