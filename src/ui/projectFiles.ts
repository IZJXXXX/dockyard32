import * as path from 'node:path';

import * as vscode from 'vscode';

const HIDDEN_ENTRIES = new Set(['.DS_Store', '.git', 'node_modules']);

type ProjectFileKind = 'workspace' | 'directory' | 'file';

export interface ProjectFileNode {
  readonly kind: ProjectFileKind;
  readonly uri: vscode.Uri;
  readonly label: string;
}

export class ProjectFilesProvider
  implements vscode.TreeDataProvider<ProjectFileNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    ProjectFileNode | undefined
  >();
  private readonly disposables: vscode.Disposable[] = [];

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.refresh()),
      watcher.onDidDelete(() => this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
  }

  public refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
  }

  public getTreeItem(element: ProjectFileNode): vscode.TreeItem {
    const directory = element.kind !== 'file';
    const item = new vscode.TreeItem(
      element.label,
      directory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.resourceUri = element.uri;
    item.tooltip = element.uri.fsPath;
    item.iconPath = directory ? new vscode.ThemeIcon('folder') : undefined;
    item.contextValue = directory
      ? 'dockyard32.projectDirectory'
      : 'dockyard32.projectFile';
    if (!directory) {
      item.command = {
        command: 'dockyard32.openProjectFile',
        title: 'Open File in Editor',
        arguments: [element.uri],
      };
    }
    return item;
  }

  public async getChildren(element?: ProjectFileNode): Promise<ProjectFileNode[]> {
    if (element === undefined) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const onlyFolder = folders.length === 1 ? folders[0] : undefined;
      if (onlyFolder !== undefined) {
        return this.readDirectory(onlyFolder.uri);
      }
      return folders.map((folder) => ({
        kind: 'workspace',
        uri: folder.uri,
        label: folder.name,
      }));
    }
    return element.kind === 'file' ? [] : this.readDirectory(element.uri);
  }

  private async readDirectory(directory: vscode.Uri): Promise<ProjectFileNode[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(directory);
      return entries
        .filter(([name]) => !HIDDEN_ENTRIES.has(name))
        .map(([name, fileType]) => {
          const symbolicLink = (fileType & vscode.FileType.SymbolicLink) !== 0;
          const isDirectory =
            !symbolicLink && (fileType & vscode.FileType.Directory) !== 0;
          return {
            kind: isDirectory ? 'directory' : 'file',
            uri: vscode.Uri.joinPath(directory, name),
            label: name,
          } satisfies ProjectFileNode;
        })
        .sort(compareNodes);
    } catch {
      return [];
    }
  }
}

export async function openProjectFile(uri: vscode.Uri): Promise<void> {
  if (!isWorkspaceFile(uri)) {
    await vscode.window.showErrorMessage(
      'Dockyard32: The selected file is outside the current workspace.',
    );
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
    });
  } catch {
    await vscode.commands.executeCommand('vscode.open', uri, {
      preview: false,
      preserveFocus: false,
    });
  }
}

export async function openProjectFileWithAi(uri: vscode.Uri): Promise<void> {
  await openProjectFile(uri);
  if (!isWorkspaceFile(uri)) {
    return;
  }
  await vscode.commands.executeCommand('workbench.action.chat.open');
}

function compareNodes(left: ProjectFileNode, right: ProjectFileNode): number {
  const leftDirectory = left.kind === 'file' ? 1 : 0;
  const rightDirectory = right.kind === 'file' ? 1 : 0;
  return leftDirectory - rightDirectory ||
    left.label.localeCompare(right.label, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
}

function isWorkspaceFile(uri: vscode.Uri): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
    const relative = path.relative(folder.uri.fsPath, uri.fsPath);
    return relative.length > 0 &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
  });
}
