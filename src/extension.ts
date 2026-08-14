import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';

import { Dockyard32OperationLock } from './core/operationLock';
import {
  importMdkProjectToCmake,
  previewMdkImport,
} from './core/mdkImport';
import { exportCmakeProjectToMdk } from './core/mdkExport';
import { parseMdkProject } from './core/mdk';
import { detectProject } from './core/project';
import { normalizeStm32Device, stm32Family } from './core/stm32Device';
import { SerialService } from './core/serial';
import { Dockyard32Controller } from './ui/controller';
import { ActionsViewProvider } from './ui/actionsPanel';
import {
  openProjectFile,
  openProjectFileWithAi,
  ProjectFilesProvider,
} from './ui/projectFiles';
import { SerialController } from './ui/serialController';
import { Dockyard32SidebarProvider } from './ui/sidebar';

const promptedMdkProjects = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  const sidebarProvider = new Dockyard32SidebarProvider();
  const serialService = new SerialService();
  const operationLock = new Dockyard32OperationLock(() =>
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );
  const serialController = new SerialController(sidebarProvider, serialService);
  const projectFilesProvider = new ProjectFilesProvider();
  const actionsProvider = new ActionsViewProvider();
  const controller = new Dockyard32Controller(
    sidebarProvider,
    operationLock,
    serialService,
    (runId, timestamp) => serialController.appendRunMarker(runId, timestamp),
    (progress) => actionsProvider.setProgress(progress),
  );

  context.subscriptions.push(
    sidebarProvider,
    projectFilesProvider,
    actionsProvider,
    controller,
    serialController,
    vscode.window.registerTreeDataProvider(
      'dockyard32.overview',
      sidebarProvider,
    ),
    vscode.window.registerTreeDataProvider(
      'dockyard32.projectFiles',
      projectFilesProvider,
    ),
    vscode.window.registerWebviewViewProvider(
      'dockyard32.actions',
      actionsProvider,
    ),
    vscode.commands.registerCommand('dockyard32.refresh', () => {
      return controller.refreshAll();
    }),
    vscode.commands.registerCommand('dockyard32.refreshProjectFiles', () => {
      projectFilesProvider.refresh();
    }),
    vscode.commands.registerCommand('dockyard32.showProjectFiles', async () => {
      projectFilesProvider.refresh();
      try {
        await vscode.commands.executeCommand('dockyard32.projectFiles.focus');
      } catch {
        await offerWindowReload();
      }
    }),
    vscode.commands.registerCommand(
      'dockyard32.openProjectFile',
      (uri: vscode.Uri) => openProjectFile(uri),
    ),
    vscode.commands.registerCommand(
      'dockyard32.openProjectFileWithAi',
      (node: unknown) => {
        const uri = projectFileUri(node);
        return uri === undefined ? undefined : openProjectFileWithAi(uri);
      },
    ),
    vscode.commands.registerCommand('dockyard32.openAiAssistant', () => {
      return vscode.commands.executeCommand('workbench.action.chat.open');
    }),
    vscode.commands.registerCommand('dockyard32.build', async () => {
      if (await redirectMdkActionToImport(projectFilesProvider, 'Build')) {
        return;
      }
      await controller.build();
    }),
    vscode.commands.registerCommand('dockyard32.importMdk', (projectFile?: vscode.Uri) =>
      importMdkWithUi(projectFilesProvider, projectFile)),
    vscode.commands.registerCommand('dockyard32.exportMdk', () =>
      exportMdkWithUi(projectFilesProvider)),
    vscode.commands.registerCommand('dockyard32.run', async () => {
      if (await redirectMdkActionToImport(projectFilesProvider, 'Build & Run')) {
        return;
      }
      if (await confirmAction(
        'Build & Run',
        'This will save files, build, flash and verify firmware, reset the target, and restore serial monitoring.',
        'Build & Run',
      )) {
        await controller.run();
      }
    }),
    vscode.commands.registerCommand('dockyard32.flash', async () => {
      if (await confirmAction(
        'Flash Firmware',
        'This will write and verify the current firmware artifact on the connected STM32 target.',
        'Flash',
      )) {
        await controller.flash();
      }
    }),
    vscode.commands.registerCommand('dockyard32.reset', async () => {
      if (await confirmAction(
        'Reset Target',
        'This will immediately reset the STM32 target connected through ST-LINK.',
        'Reset',
      )) {
        await controller.reset();
      }
    }),
    vscode.commands.registerCommand('dockyard32.openSerial', () => {
      serialController.showPanel();
    }),
    vscode.commands.registerCommand('dockyard32.showMcpSetup', async () => {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspacePath === undefined) {
        await vscode.window.showErrorMessage(
          'Dockyard32: Open an STM32 workspace before generating MCP setup.',
        );
        return;
      }
      const serverPath = vscode.Uri.joinPath(
        context.extensionUri,
        'out',
        'mcp',
        'server.js',
      ).fsPath;
      const configuration = JSON.stringify(
        {
          mcpServers: {
            'dockyard32': {
              command: process.execPath,
              args: [serverPath, '--workspace', workspacePath],
              env: { ELECTRON_RUN_AS_NODE: '1' },
            },
          },
        },
        undefined,
        2,
      );
      const document = await vscode.workspace.openTextDocument({
        language: 'json',
        content: configuration,
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
  );

  void Promise.all([controller.initialize(), serialController.initialize()]).then(
    async () => {
      if (!(await ensureDockyard32ViewsAvailable())) {
        return;
      }
      const introductionKey = 'dockyard32.projectFilesIntroduced.v1';
      if (!context.workspaceState.get<boolean>(introductionKey, false)) {
        await vscode.commands.executeCommand('dockyard32.projectFiles.focus');
        await context.workspaceState.update(introductionKey, true);
      }
      await offerDetectedMdkImport();
    },
  );
}

export function deactivate(): void {
  // VS Code disposes registered resources through ExtensionContext subscriptions.
}

async function confirmAction(
  title: string,
  detail: string,
  confirmLabel: string,
): Promise<boolean> {
  const selected = await vscode.window.showWarningMessage(
    `Dockyard32: ${title}?`,
    { modal: true, detail },
    confirmLabel,
  );
  return selected === confirmLabel;
}

function projectFileUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) {
    return value;
  }
  if (typeof value !== 'object' || value === null || !('uri' in value)) {
    return undefined;
  }
  const uri = (value as { readonly uri?: unknown }).uri;
  return uri instanceof vscode.Uri ? uri : undefined;
}

async function ensureDockyard32ViewsAvailable(): Promise<boolean> {
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes('dockyard32.projectFiles.focus')) {
    await offerWindowReload();
    return false;
  }
  return true;
}

async function offerWindowReload(): Promise<void> {
  const reload = 'Reload Window';
  const selected = await vscode.window.showInformationMessage(
    'Dockyard32 views were updated. Reload this VS Code window when convenient to make them available.',
    reload,
  );
  if (selected === reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function importMdkWithUi(
  projectFilesProvider: ProjectFilesProvider,
  requestedProjectFile?: vscode.Uri,
): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let projectFile = requestedProjectFile?.fsPath;
  let sourceRoot: string | undefined;
  if (workspacePath !== undefined) {
    const detected = await detectProject(workspacePath);
    projectFile ??= detected.mdk?.projectFile;
    sourceRoot = detected.mdk?.projectFile === projectFile
      ? detected.projectRoot
      : undefined;
  }
  if (projectFile === undefined) {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Import Keil Project',
      filters: { 'Keil MDK project': ['uvprojx'] },
    });
    projectFile = selected?.[0]?.fsPath;
  }
  if (projectFile === undefined) {
    return;
  }
  let targetName: string | undefined;
  let selectedDevice: string | undefined;
  try {
    const parsed = await parseMdkProject(projectFile);
    if (parsed.targets.length > 1) {
      const selected = await vscode.window.showQuickPick(
        parsed.targets.map((target) => ({
          label: target.name,
          description: target.device ?? 'MCU not specified',
          target,
        })),
        { placeHolder: 'Select the Keil target to import' },
      );
      if (selected === undefined) {
        return;
      }
      targetName = selected.target.name;
      selectedDevice = selected.target.device;
    } else {
      targetName = parsed.targets[0]?.name;
      selectedDevice = parsed.targets[0]?.device;
    }
  } catch {
    // Core import reports malformed project details consistently.
  }
  if (selectedDevice === undefined || stm32Family(selectedDevice) === undefined) {
    selectedDevice = await chooseMcu(selectedDevice);
    if (selectedDevice === undefined) {
      return;
    }
  }
  const preview = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Dockyard32: Inspecting Keil import inputs',
    },
    () => previewMdkImport(projectFile, {
      sourceRoot,
      targetName,
      device: selectedDevice,
    }),
  );
  if (!preview.success) {
    await vscode.window.showErrorMessage(
      `Dockyard32: Cannot safely import this project — ${preview.error ?? 'unknown error'}`,
    );
    return;
  }
  const externalSummary = preview.externalDirectories.length === 0
    ? 'No files outside the approved project root.'
    : `External directories (${preview.externalDirectoryCount}):\n${preview.externalDirectories.map((directory) => `• ${directory}`).join('\n')}${preview.externalDirectoryCount > preview.externalDirectories.length ? '\n• …' : ''}`;
  const continueLabel = 'Choose Empty Destination…';
  const previewChoice = await vscode.window.showWarningMessage(
    `Import ${preview.fileCount} selected files (${formatByteCount(preview.totalBytes)}) from Keil target ${preview.targetName ?? 'unknown'}?`,
    {
      modal: true,
      detail: `${preview.externalFileCount} external file${preview.externalFileCount === 1 ? '' : 's'} will be copied individually into External/.\n\n${externalSummary}`,
    },
    continueLabel,
  );
  if (previewChoice !== continueLabel) {
    return;
  }
  const destination = await chooseConversionDirectory(
    'Import into this empty folder',
    'defaultImportDirectory',
  );
  if (destination === undefined) {
    return;
  }
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Dockyard32: Importing Keil MDK project',
    },
    () => importMdkProjectToCmake(projectFile, {
      destinationDirectory: destination,
      sourceRoot,
      targetName,
      device: selectedDevice,
    }),
  );
  if (!result.success || result.projectDirectory === undefined) {
    await vscode.window.showErrorMessage(
      `Dockyard32: MDK import failed — ${result.error ?? 'unknown error'}`,
    );
    return;
  }
  projectFilesProvider.refresh();
  const warningSuffix = result.warnings.length === 0
    ? ''
    : ` ${result.warnings.length} compatibility warning${result.warnings.length === 1 ? '' : 's'} recorded.`;
  const openLabel = 'Open Imported Project';
  const selected = await vscode.window.showInformationMessage(
    `Dockyard32: Native macOS CMake project created.${warningSuffix}`,
    openLabel,
  );
  if (selected === openLabel) {
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(result.projectDirectory),
      true,
    );
  }
}

async function redirectMdkActionToImport(
  projectFilesProvider: ProjectFilesProvider,
  requestedAction: 'Build' | 'Build & Run',
): Promise<boolean> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspacePath === undefined) {
    return false;
  }
  const project = await detectProject(workspacePath);
  const projectFile = project.mdk?.projectFile;
  if (project.buildSystem !== 'mdk' || projectFile === undefined) {
    return false;
  }
  const convert = 'Choose Destination…';
  const selected = await vscode.window.showInformationMessage(
    `Dockyard32: ${requestedAction} needs a native macOS CMake copy of this Keil MDK project.`,
    {
      modal: true,
      detail: 'The original Keil project will not be modified. Choose an empty folder for the converted copy; then open that copy to Build or Build & Run.',
    },
    convert,
  );
  if (selected === convert) {
    await importMdkWithUi(projectFilesProvider, vscode.Uri.file(projectFile));
  }
  return true;
}

async function exportMdkWithUi(
  projectFilesProvider: ProjectFilesProvider,
): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspacePath === undefined) {
    await vscode.window.showErrorMessage(
      'Dockyard32: Open a CMake STM32 project before exporting MDK.',
    );
    return;
  }
  const destination = await chooseConversionDirectory(
    'Export Keil project here',
    'defaultExportDirectory',
  );
  if (destination === undefined) {
    return;
  }
  await vscode.workspace.saveAll(false);
  const project = await detectProject(workspacePath);
  const selectedDevice = project.mcu === undefined || stm32Family(project.mcu) === undefined
    ? await chooseMcu(project.mcu)
    : project.mcu;
  if (selectedDevice === undefined) {
    return;
  }
  try {
    if ((await fs.readdir(destination)).length > 0) {
      await vscode.window.showErrorMessage(
        'Dockyard32: Choose an empty folder for Keil export. Existing files are never overwritten.',
      );
      return;
    }
  } catch {
    // A missing destination is created by the Core exporter.
  }
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Dockyard32: Exporting Keil MDK project',
    },
    () => exportCmakeProjectToMdk(project, {
      destinationDirectory: destination,
      device: selectedDevice,
    }),
  );
  if (!result.success || result.projectFile === undefined) {
    await vscode.window.showErrorMessage(
      `Dockyard32: MDK export failed — ${result.error ?? 'unknown error'}`,
    );
    return;
  }
  projectFilesProvider.refresh();
  await openProjectFile(vscode.Uri.file(result.projectFile));
  const suffix = result.warnings.length === 0
    ? ''
    : ` (${result.warnings.length} compatibility warning${result.warnings.length === 1 ? '' : 's'})`;
  await vscode.window.showInformationMessage(
    `Dockyard32: Keil MDK project exported${suffix}`,
  );
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function chooseMcu(current?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Select STM32 MCU',
    prompt: 'Enter the exact STM32F1, STM32F4, or STM32G4 part number',
    placeHolder: 'STM32G474VET6',
    value: current,
    validateInput: (value) => stm32Family(value) === undefined
      ? 'Enter a supported STM32F1, STM32F4, or STM32G4 device'
      : undefined,
  }).then((value) => value === undefined ? undefined : normalizeStm32Device(value));
}

async function chooseConversionDirectory(
  openLabel: string,
  setting: 'defaultImportDirectory' | 'defaultExportDirectory',
): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration('dockyard32.mdk')
    .get<string>(setting, '')
    .trim();
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel,
    defaultUri: configured.length === 0 ? undefined : vscode.Uri.file(configured),
  });
  return selected?.[0]?.fsPath;
}

async function offerDetectedMdkImport(): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const enabled = vscode.workspace
    .getConfiguration('dockyard32.mdk')
    .get<boolean>('promptOnDetection', true);
  if (workspacePath === undefined || !enabled) {
    return;
  }
  const project = await detectProject(workspacePath);
  const projectFile = project.mdk?.projectFile;
  if (project.buildSystem !== 'mdk' || projectFile === undefined) {
    return;
  }
  if (promptedMdkProjects.has(projectFile)) {
    return;
  }
  promptedMdkProjects.add(projectFile);
  const convert = 'Convert to CMake…';
  const disable = 'Don’t Ask Again';
  const selected = await vscode.window.showInformationMessage(
    'Dockyard32 detected a Keil MDK project. Convert a copy for native macOS build and flash?',
    convert,
    'Not Now',
    disable,
  );
  if (selected === convert) {
    await vscode.commands.executeCommand(
      'dockyard32.importMdk',
      vscode.Uri.file(projectFile),
    );
  } else if (selected === disable) {
    await vscode.workspace.getConfiguration('dockyard32.mdk').update(
      'promptOnDetection',
      false,
      vscode.ConfigurationTarget.Global,
    );
  }
}
