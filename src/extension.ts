import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';

import { WorkbenchOperationLock } from './core/operationLock';
import {
  importMdkProjectToCmake,
  previewMdkImport,
} from './core/mdkImport';
import { exportCmakeProjectToMdk } from './core/mdkExport';
import { parseMdkProject } from './core/mdk';
import { detectProject } from './core/project';
import { normalizeStm32Device, stm32Family } from './core/stm32Device';
import { SerialService } from './core/serial';
import { WorkbenchController } from './ui/controller';
import { ActionsViewProvider } from './ui/actionsPanel';
import {
  openProjectFile,
  openProjectFileWithAi,
  ProjectFilesProvider,
} from './ui/projectFiles';
import { SerialController } from './ui/serialController';
import { WorkbenchSidebarProvider } from './ui/sidebar';

const promptedMdkProjects = new Set<string>();

export function activate(context: vscode.ExtensionContext): void {
  const sidebarProvider = new WorkbenchSidebarProvider();
  const serialService = new SerialService();
  const operationLock = new WorkbenchOperationLock(() =>
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  );
  const serialController = new SerialController(sidebarProvider, serialService);
  const projectFilesProvider = new ProjectFilesProvider();
  const actionsProvider = new ActionsViewProvider();
  const controller = new WorkbenchController(
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
      'stm32Workbench.overview',
      sidebarProvider,
    ),
    vscode.window.registerTreeDataProvider(
      'stm32Workbench.projectFiles',
      projectFilesProvider,
    ),
    vscode.window.registerWebviewViewProvider(
      'stm32Workbench.actions',
      actionsProvider,
    ),
    vscode.commands.registerCommand('stm32Workbench.refresh', () => {
      return controller.refreshAll();
    }),
    vscode.commands.registerCommand('stm32Workbench.refreshProjectFiles', () => {
      projectFilesProvider.refresh();
    }),
    vscode.commands.registerCommand('stm32Workbench.showProjectFiles', async () => {
      projectFilesProvider.refresh();
      try {
        await vscode.commands.executeCommand('stm32Workbench.projectFiles.focus');
      } catch {
        await offerWindowReload();
      }
    }),
    vscode.commands.registerCommand(
      'stm32Workbench.openProjectFile',
      (uri: vscode.Uri) => openProjectFile(uri),
    ),
    vscode.commands.registerCommand(
      'stm32Workbench.openProjectFileWithAi',
      (node: unknown) => {
        const uri = projectFileUri(node);
        return uri === undefined ? undefined : openProjectFileWithAi(uri);
      },
    ),
    vscode.commands.registerCommand('stm32Workbench.openAiAssistant', () => {
      return vscode.commands.executeCommand('workbench.action.chat.open');
    }),
    vscode.commands.registerCommand('stm32Workbench.build', async () => {
      if (await redirectMdkActionToImport(projectFilesProvider, 'Build')) {
        return;
      }
      await controller.build();
    }),
    vscode.commands.registerCommand('stm32Workbench.importMdk', (projectFile?: vscode.Uri) =>
      importMdkWithUi(projectFilesProvider, projectFile)),
    vscode.commands.registerCommand('stm32Workbench.exportMdk', () =>
      exportMdkWithUi(projectFilesProvider)),
    vscode.commands.registerCommand('stm32Workbench.run', async () => {
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
    vscode.commands.registerCommand('stm32Workbench.flash', async () => {
      if (await confirmAction(
        'Flash Firmware',
        'This will write and verify the current firmware artifact on the connected STM32 target.',
        'Flash',
      )) {
        await controller.flash();
      }
    }),
    vscode.commands.registerCommand('stm32Workbench.reset', async () => {
      if (await confirmAction(
        'Reset Target',
        'This will immediately reset the STM32 target connected through ST-LINK.',
        'Reset',
      )) {
        await controller.reset();
      }
    }),
    vscode.commands.registerCommand('stm32Workbench.openSerial', () => {
      serialController.showPanel();
    }),
    vscode.commands.registerCommand('stm32Workbench.showMcpSetup', async () => {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspacePath === undefined) {
        await vscode.window.showErrorMessage(
          'STM32 Workbench: Open an STM32 workspace before generating MCP setup.',
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
            'stm32-workbench': {
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
      if (!(await ensureWorkbenchViewsAvailable())) {
        return;
      }
      const introductionKey = 'stm32Workbench.projectFilesIntroduced.v1';
      if (!context.workspaceState.get<boolean>(introductionKey, false)) {
        await vscode.commands.executeCommand('stm32Workbench.projectFiles.focus');
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
    `STM32 Workbench: ${title}?`,
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

async function ensureWorkbenchViewsAvailable(): Promise<boolean> {
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes('stm32Workbench.projectFiles.focus')) {
    await offerWindowReload();
    return false;
  }
  return true;
}

async function offerWindowReload(): Promise<void> {
  const reload = 'Reload Window';
  const selected = await vscode.window.showInformationMessage(
    'STM32 Workbench views were updated. Reload this VS Code window when convenient to make them available.',
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
      title: 'STM32 Workbench: Inspecting Keil import inputs',
    },
    () => previewMdkImport(projectFile, {
      sourceRoot,
      targetName,
      device: selectedDevice,
    }),
  );
  if (!preview.success) {
    await vscode.window.showErrorMessage(
      `STM32 Workbench: Cannot safely import this project — ${preview.error ?? 'unknown error'}`,
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
      title: 'STM32 Workbench: Importing Keil MDK project',
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
      `STM32 Workbench: MDK import failed — ${result.error ?? 'unknown error'}`,
    );
    return;
  }
  projectFilesProvider.refresh();
  const warningSuffix = result.warnings.length === 0
    ? ''
    : ` ${result.warnings.length} compatibility warning${result.warnings.length === 1 ? '' : 's'} recorded.`;
  const openLabel = 'Open Imported Project';
  const selected = await vscode.window.showInformationMessage(
    `STM32 Workbench: Native macOS CMake project created.${warningSuffix}`,
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
    `STM32 Workbench: ${requestedAction} needs a native macOS CMake copy of this Keil MDK project.`,
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
      'STM32 Workbench: Open a CMake STM32 project before exporting MDK.',
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
        'STM32 Workbench: Choose an empty folder for Keil export. Existing files are never overwritten.',
      );
      return;
    }
  } catch {
    // A missing destination is created by the Core exporter.
  }
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'STM32 Workbench: Exporting Keil MDK project',
    },
    () => exportCmakeProjectToMdk(project, {
      destinationDirectory: destination,
      device: selectedDevice,
    }),
  );
  if (!result.success || result.projectFile === undefined) {
    await vscode.window.showErrorMessage(
      `STM32 Workbench: MDK export failed — ${result.error ?? 'unknown error'}`,
    );
    return;
  }
  projectFilesProvider.refresh();
  await openProjectFile(vscode.Uri.file(result.projectFile));
  const suffix = result.warnings.length === 0
    ? ''
    : ` (${result.warnings.length} compatibility warning${result.warnings.length === 1 ? '' : 's'})`;
  await vscode.window.showInformationMessage(
    `STM32 Workbench: Keil MDK project exported${suffix}`,
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
    .getConfiguration('stm32Workbench.mdk')
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
    .getConfiguration('stm32Workbench.mdk')
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
    'STM32 Workbench detected a Keil MDK project. Convert a copy for native macOS build and flash?',
    convert,
    'Not Now',
    disable,
  );
  if (selected === convert) {
    await vscode.commands.executeCommand(
      'stm32Workbench.importMdk',
      vscode.Uri.file(projectFile),
    );
  } else if (selected === disable) {
    await vscode.workspace.getConfiguration('stm32Workbench.mdk').update(
      'promptOnDetection',
      false,
      vscode.ConfigurationTarget.Global,
    );
  }
}
