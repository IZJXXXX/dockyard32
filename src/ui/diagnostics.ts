import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { BuildDiagnostic } from '../types/build';

export function publishBuildDiagnostics(
  collection: vscode.DiagnosticCollection,
  projectRoot: string | undefined,
  buildDir: string | undefined,
  diagnostics: readonly BuildDiagnostic[],
): void {
  collection.clear();
  if (projectRoot === undefined) {
    return;
  }

  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.file === undefined) {
      continue;
    }

    const absolutePath = resolveDiagnosticPath(
      diagnostic.file,
      projectRoot,
      buildDir,
    );
    const line = Math.max(0, (diagnostic.line ?? 1) - 1);
    const column = Math.max(0, (diagnostic.column ?? 1) - 1);
    const range = new vscode.Range(line, column, line, column + 1);
    const vscodeDiagnostic = new vscode.Diagnostic(
      range,
      diagnostic.message,
      diagnostic.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning,
    );
    vscodeDiagnostic.source = 'Dockyard32';

    const existing = byFile.get(absolutePath) ?? [];
    existing.push(vscodeDiagnostic);
    byFile.set(absolutePath, existing);
  }

  for (const [file, fileDiagnostics] of byFile) {
    collection.set(vscode.Uri.file(file), fileDiagnostics);
  }
}

function resolveDiagnosticPath(
  file: string,
  projectRoot: string,
  buildDir: string | undefined,
): string {
  if (path.isAbsolute(file)) {
    return file;
  }

  const projectCandidate = path.resolve(projectRoot, file);
  if (fs.existsSync(projectCandidate) || buildDir === undefined) {
    return projectCandidate;
  }

  const buildCandidate = path.resolve(buildDir, file);
  return fs.existsSync(buildCandidate) ? buildCandidate : projectCandidate;
}
