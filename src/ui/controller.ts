import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import * as vscode from 'vscode';

import { buildProject } from '../core/build';
import { getDeviceStatus } from '../core/device';
import { flashFirmware, resetTarget } from '../core/flash';
import { buildAndRun } from '../core/run';
import { writeLastRunResult } from '../core/runStore';
import { SerialService } from '../core/serial';
import { detectProject } from '../core/project';
import { discoverDevelopmentTools } from '../core/tools';
import type { BuildResult } from '../types/build';
import type { DeviceStatus } from '../types/device';
import type { FlashResult, ResetResult } from '../types/flash';
import type { Stm32ProjectInfo } from '../types/project';
import type { DevelopmentTools, ToolKind } from '../types/tools';
import type { OperationLease, OperationLock } from '../types/run';
import type { RunProgress, RunResult } from '../types/run';
import type {
  WorkbenchProgressOperation,
  WorkbenchProgressReporter,
  WorkbenchProgressStatus,
} from '../types/progress';
import { publishBuildDiagnostics } from './diagnostics';
import {
  parseCommandProgress,
  programmerProgressFromOutput,
  scaleProgress,
} from './progress';
import { readSerialConfiguration } from './serialController';
import { WorkbenchSidebarProvider } from './sidebar';

export class WorkbenchController implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('STM32 Workbench');
  private readonly diagnostics =
    vscode.languages.createDiagnosticCollection('stm32-workbench');
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private tools?: DevelopmentTools;
  private building = false;
  private programming = false;

  public constructor(
    private readonly sidebar: WorkbenchSidebarProvider,
    private readonly operationLock?: OperationLock,
    private readonly serialService?: SerialService,
    private readonly appendRunMarker?: (runId: number, timestamp: number) => void,
    private readonly reportProgress?: WorkbenchProgressReporter,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/{*.ioc,CMakeLists.txt,*.ld,startup_stm32*.s,startup_stm32*.S,startup_stm32*.asm}',
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.scheduleDetection()),
      watcher.onDidChange(() => this.scheduleDetection()),
      watcher.onDidDelete(() => this.scheduleDetection()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.scheduleDetection();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('stm32Workbench.tools')) {
          void this.refreshHardware();
        }
      }),
    );
  }

  public async initialize(): Promise<void> {
    await this.refreshAll();
  }

  public async refreshAll(): Promise<void> {
    await Promise.all([this.refreshProject(), this.refreshHardware()]);
  }

  public async refreshProject(): Promise<Stm32ProjectInfo> {
    this.sidebar.setDetecting();
    this.output.appendLine('[STM32] Detecting project...');
    const project = await this.detectWorkspaceProject();
    this.sidebar.setProjectInfo(project);
    this.logProject(project);
    return project;
  }

  public async refreshHardware(): Promise<DeviceStatus> {
    this.sidebar.setHardwareDetecting();
    this.output.appendLine('[STM32] Discovering development tools...');
    const tools = await discoverDevelopmentTools({
      configured: configuredToolPaths(),
    });
    this.tools = tools;
    this.logTools(tools);

    this.output.appendLine('[STM32] Detecting ST-LINK...');
    const status = await getDeviceStatus(tools.programmer.executable);
    this.sidebar.setHardwareStatus(tools, status);
    this.logDevice(status);
    return status;
  }

  public async run(): Promise<void> {
    const lease = this.operationLock?.acquire('run');
    if (this.operationLock !== undefined && lease === undefined) {
      void vscode.window.showInformationMessage(
        this.operationLock.getActiveOperation() === 'run'
          ? 'STM32 Workbench: Build & Run is already in progress.'
          : 'STM32 Workbench: Another operation is already in progress.',
      );
      return;
    }

    let coreStarted = false;
    this.sidebar.setRunPreparing();
    this.updateProgress('run', 'running', 'Preparing', 3, 'Saving files…');
    this.output.clear();
    this.output.show(true);
    this.output.appendLine('[Run] Saving files...');
    try {
      await vscode.workspace.saveAll(false);
      const [project, tools] = await Promise.all([
        this.refreshProject(),
        this.ensureTools(),
      ]);
      this.diagnostics.clear();
      const runConfiguration = vscode.workspace.getConfiguration(
        'stm32Workbench.run',
      );
      const verify = vscode.workspace
        .getConfiguration('stm32Workbench.flash')
        .get<boolean>('verify', true);
      const serialSettings = readSerialConfiguration();
      let markerAdded = false;
      let serialConnectionLogged = false;
      coreStarted = true;
      const result = await buildAndRun({
        project,
        cmakeExecutable: tools.cmake.executable,
        programmerExecutable: tools.programmer.executable,
        env: toolEnvironment(tools),
        verify,
        serial: this.serialService,
        serialSettings,
        waitForSerialReady: runConfiguration.get<boolean>(
          'waitForSerialReady',
          false,
        ),
        readyPattern: runConfiguration.get<string>(
          'readyPattern',
          'SYSTEM READY',
        ),
        readyTimeoutMs: runConfiguration.get<number>('readyTimeoutMs', 5_000),
        clearSerialBeforeRun: runConfiguration.get<boolean>(
          'clearSerialBeforeRun',
          false,
        ),
        operationLock: this.operationLock,
        operationLease: lease,
        onProgress: (progress) => {
          this.sidebar.setRunProgress(progress);
          this.updateRunProgress(progress);
          this.logRunProgress(progress);
          if (progress.stage === 'resetting' && !markerAdded) {
            markerAdded = true;
            this.appendRunMarker?.(progress.runId, Date.now());
          }
          if (
            progress.stage === 'serial' &&
            progress.message?.startsWith('Serial connected:') === true
          ) {
            serialConnectionLogged = true;
          }
        },
        onBuildOutput: (event) => {
          this.appendProcessOutput(event.text);
          const percent = parseCommandProgress(event.text);
          if (percent !== undefined) {
            this.updateProgress(
              'run',
              'running',
              'Build',
              scaleProgress(percent, 10, 38),
              'Compiling firmware…',
            );
          }
        },
        onProgrammerOutput: (event) => {
          this.appendProcessOutput(event.text);
          const parsed = programmerProgressFromOutput(event.text, verify);
          if (parsed !== undefined) {
            const programmerPercent = parsed.stage === 'verifying'
              ? scaleProgress((parsed.percent - 80) / 0.18, 80, 5)
              : scaleProgress((parsed.percent - 30) / 0.48, 58, 22);
            this.updateProgress(
              'run',
              'running',
              parsed.stage === 'verifying' ? 'Verify' : 'Flash',
              programmerPercent,
              parsed.stage === 'verifying'
                ? 'Verifying firmware…'
                : 'Downloading firmware…',
            );
          }
        },
      });
      if (result.serialConnected && !serialConnectionLogged) {
        this.output.appendLine(
          `[Run #${result.runId}] Serial connected: ${result.serialPort ?? 'unknown port'}`,
        );
      }
      this.sidebar.setRunResult(result);
      if (project.workspacePath !== undefined) {
        try {
          await writeLastRunResult(project.workspacePath, result);
        } catch (error: unknown) {
          this.output.appendLine(
            `[Run #${result.runId}] Warning: Unable to persist Last Run: ${errorMessage(error)}`,
          );
        }
      }
      if (result.build !== undefined) {
        publishBuildDiagnostics(
          this.diagnostics,
          project.projectRoot,
          project.buildDir,
          [...result.build.errors, ...result.build.warnings],
        );
      }
      this.reportRunResult(result);
      this.updateProgress(
        'run',
        result.success ? 'succeeded' : 'failed',
        result.success ? 'Build & Run complete' : 'Build & Run failed',
        100,
        result.success
          ? `Completed in ${(result.durationMs / 1_000).toFixed(2)} s`
          : result.error ?? 'Operation failed',
      );
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.sidebar.setRunPreparationFailure(message);
      this.output.appendLine(`[Run] Preparation failed: ${message}`);
      void vscode.window.showErrorMessage(
        `STM32 Workbench: Build & Run failed — ${message}`,
      );
      this.updateProgress('run', 'failed', 'Build & Run failed', 100, message);
    } finally {
      if (!coreStarted || lease !== undefined) {
        lease?.release();
      }
    }
  }

  public async build(): Promise<void> {
    if (this.building) {
      void vscode.window.showInformationMessage(
        'STM32 Workbench: A build is already running.',
      );
      return;
    }
    const lease = this.acquireOperation('build');
    if (lease === undefined) {
      return;
    }

    this.building = true;
    this.sidebar.setBuildRunning('detecting');
    this.updateProgress('build', 'running', 'Build', 4, 'Saving files…');
    this.output.clear();
    this.output.show(true);
    this.output.appendLine('[STM32] Saving files...');

    try {
      await vscode.workspace.saveAll(false);
      const [project, tools] = await Promise.all([
        this.refreshProject(),
        this.ensureTools(),
      ]);
      this.diagnostics.clear();

      const preflight = buildPreflight(project, tools);
      if (preflight !== undefined) {
        this.sidebar.setBuildResult(preflightFailure(preflight));
        this.output.appendLine(`[STM32] ${preflight}.`);
        void vscode.window.showErrorMessage(`STM32 Workbench: ${preflight}`);
        this.updateProgress('build', 'failed', 'Build failed', 100, preflight);
        return;
      }

      this.sidebar.setBuildRunning('building');
      this.updateProgress('build', 'running', 'Build', 18, 'Preparing CMake…');
      const result = await buildProject(project, {
        cmakeExecutable: tools.cmake.executable,
        env: toolEnvironment(tools),
        onStage: (stage) => {
          this.updateProgress(
            'build',
            'running',
            stage === 'configure' ? 'Configure' : stage === 'mirror' ? 'MDK Mirror' : 'Build',
            stage === 'configure' ? 22 : stage === 'mirror' ? 18 : 35,
            stage === 'configure'
              ? 'Configuring CMake…'
              : stage === 'mirror' ? 'Preparing Keil build mirror…' : 'Compiling firmware…',
          );
          this.output.appendLine(
            stage === 'configure'
              ? '[STM32] Configuring CMake...'
              : stage === 'mirror' ? '[STM32] Preparing MDK mirror...' : '[STM32] Building...',
          );
        },
        onOutput: (event) => {
          this.appendProcessOutput(event.text);
          const percent = parseCommandProgress(event.text);
          if (percent !== undefined) {
            this.updateProgress(
              'build',
              'running',
              event.stage === 'configure' ? 'Configure' : event.stage === 'mirror' ? 'MDK Mirror' : 'Build',
              event.stage === 'configure'
                ? scaleProgress(percent, 22, 12)
                : scaleProgress(percent, 35, 60),
              event.stage === 'configure'
                ? 'Configuring CMake…'
                : 'Compiling firmware…',
            );
          }
        },
      });

      this.sidebar.setBuildResult(result);
      publishBuildDiagnostics(
        this.diagnostics,
        project.projectRoot,
        project.buildDir,
        [...result.errors, ...result.warnings],
      );
      this.reportBuildResult(result);
      this.updateProgress(
        'build',
        result.success ? 'succeeded' : 'failed',
        result.success ? 'Build complete' : 'Build failed',
        100,
        result.success
          ? `Completed in ${(result.durationMs / 1_000).toFixed(2)} s`
          : `${result.errors.length} errors, ${result.warnings.length} warnings`,
      );
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.sidebar.setBuildResult(preflightFailure(message));
      this.output.appendLine(`[STM32] Unexpected build error: ${message}`);
      void vscode.window.showErrorMessage(
        `STM32 Workbench: Unexpected build error: ${message}`,
      );
      this.updateProgress('build', 'failed', 'Build failed', 100, message);
    } finally {
      this.building = false;
      lease.release();
    }
  }

  public async flash(): Promise<void> {
    const lease = this.acquireOperation('flash');
    if (lease === undefined) {
      return;
    }
    if (!this.beginProgramming('flash')) {
      lease.release();
      return;
    }

    this.output.clear();
    this.updateProgress('flash', 'running', 'Flash', 5, 'Checking project and ST-LINK…');
    this.output.show(true);
    this.output.appendLine('[STM32] Preparing to flash firmware...');
    try {
      const [project, status] = await Promise.all([
        this.refreshProject(),
        this.refreshHardware(),
      ]);
      const preflight = programmerPreflight(project, status);
      if (preflight !== undefined) {
        this.sidebar.setProgrammerResult(flashFailure(preflight));
        this.output.appendLine(`[STM32] ${preflight}.`);
        void vscode.window.showErrorMessage(`STM32 Workbench: ${preflight}`);
        this.updateProgress('flash', 'failed', 'Flash failed', 100, preflight);
        return;
      }

      this.sidebar.setProgrammerRunning('flash');
      const verify = vscode.workspace
        .getConfiguration('stm32Workbench.flash')
        .get<boolean>('verify', true);
      this.updateProgress('flash', 'running', 'Flash', 28, 'Downloading firmware…');
      const result = await flashFirmware(project, {
        programmerExecutable: this.tools?.programmer.executable,
        verify,
        reset: false,
        onOutput: (event) => {
          this.appendProcessOutput(event.text);
          const parsed = programmerProgressFromOutput(event.text, verify);
          if (parsed !== undefined) {
            this.updateProgress(
              'flash',
              'running',
              parsed.stage === 'verifying' ? 'Verify' : 'Flash',
              parsed.percent,
              parsed.stage === 'verifying'
                ? 'Verifying firmware…'
                : 'Downloading firmware…',
            );
          }
        },
      });
      this.sidebar.setProgrammerResult(result);
      this.reportProgrammerResult(result);
      this.updateProgress(
        'flash',
        result.success ? 'succeeded' : 'failed',
        result.success ? 'Flash complete' : 'Flash failed',
        100,
        result.success
          ? `${result.verify ? 'Programmed and verified' : 'Programmed'} in ${(result.durationMs / 1_000).toFixed(2)} s`
          : result.error ?? 'Flash failed',
      );
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.sidebar.setProgrammerResult(flashFailure(message));
      this.output.appendLine(`[STM32] Unexpected flash error: ${message}`);
      void vscode.window.showErrorMessage(
        `STM32 Workbench: Unexpected flash error: ${message}`,
      );
      this.updateProgress('flash', 'failed', 'Flash failed', 100, message);
    } finally {
      this.programming = false;
      try {
        await this.refreshHardware();
      } finally {
        lease.release();
      }
    }
  }

  public async reset(): Promise<void> {
    const lease = this.acquireOperation('reset');
    if (lease === undefined) {
      return;
    }
    if (!this.beginProgramming('reset')) {
      lease.release();
      return;
    }

    this.output.clear();
    this.updateProgress('reset', 'running', 'Reset', 10, 'Checking ST-LINK…');
    this.output.show(true);
    this.output.appendLine('[STM32] Resetting target...');
    try {
      const status = await this.refreshHardware();
      const preflight = devicePreflight(status);
      if (preflight !== undefined) {
        this.sidebar.setProgrammerResult(resetFailure(preflight));
        this.output.appendLine(`[STM32] ${preflight}.`);
        void vscode.window.showErrorMessage(`STM32 Workbench: ${preflight}`);
        this.updateProgress('reset', 'failed', 'Reset failed', 100, preflight);
        return;
      }

      this.sidebar.setProgrammerRunning('reset');
      this.updateProgress('reset', 'running', 'Reset', 65, 'Resetting target…');
      const result = await resetTarget({
        programmerExecutable: this.tools?.programmer.executable,
        onOutput: (event) => this.appendProcessOutput(event.text),
      });
      this.sidebar.setProgrammerResult(result);
      this.reportProgrammerResult(result);
      this.updateProgress(
        'reset',
        result.success ? 'succeeded' : 'failed',
        result.success ? 'Reset complete' : 'Reset failed',
        100,
        result.success
          ? `Completed in ${(result.durationMs / 1_000).toFixed(2)} s`
          : result.error ?? 'Reset failed',
      );
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.sidebar.setProgrammerResult(resetFailure(message));
      this.output.appendLine(`[STM32] Unexpected reset error: ${message}`);
      void vscode.window.showErrorMessage(
        `STM32 Workbench: Unexpected reset error: ${message}`,
      );
      this.updateProgress('reset', 'failed', 'Reset failed', 100, message);
    } finally {
      this.programming = false;
      try {
        await this.refreshHardware();
      } finally {
        lease.release();
      }
    }
  }

  public dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.output.dispose();
    this.diagnostics.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private beginProgramming(stage: 'flash' | 'reset'): boolean {
    if (this.programming) {
      void vscode.window.showInformationMessage(
        'STM32 Workbench: A programmer operation is already running.',
      );
      return false;
    }
    this.programming = true;
    this.sidebar.setProgrammerRunning(stage);
    return true;
  }

  private appendProcessOutput(text: string): void {
    this.output.append(stripVTControlCharacters(text));
  }

  private acquireOperation(
    operation: 'build' | 'flash' | 'reset',
  ): OperationLease | undefined {
    if (this.operationLock === undefined) {
      return {
        operation,
        release: (): void => undefined,
      };
    }
    const lease = this.operationLock.acquire(operation);
    if (lease === undefined) {
      const active = this.operationLock.getActiveOperation();
      void vscode.window.showInformationMessage(
        active === 'run'
          ? 'STM32 Workbench: Build & Run is already in progress.'
          : 'STM32 Workbench: Another operation is already in progress.',
      );
    }
    return lease;
  }

  private scheduleDetection(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshProject();
    }, 300);
  }

  private async ensureTools(): Promise<DevelopmentTools> {
    if (this.tools !== undefined) {
      return this.tools;
    }
    await this.refreshHardware();
    return (
      this.tools ??
      discoverDevelopmentTools({ configured: configuredToolPaths() })
    );
  }

  private async detectWorkspaceProject(): Promise<Stm32ProjectInfo> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) {
      return detectProject();
    }

    let fallback: Stm32ProjectInfo | undefined;
    for (const folder of folders) {
      const project = await detectProject(folder.uri.fsPath);
      fallback ??= project;
      if (project.detected) {
        return project;
      }
    }
    return fallback ?? detectProject();
  }

  private reportBuildResult(result: BuildResult): void {
    const duration = (result.durationMs / 1_000).toFixed(2);
    if (result.success) {
      this.output.appendLine(`\n[STM32] Build succeeded in ${duration} s.`);
      void vscode.window.showInformationMessage(
        `STM32 Workbench: Build succeeded (${duration} s)`,
      );
    } else {
      this.output.appendLine(
        `\n[STM32] ${capitalize(result.stage)} failed: ${result.errors.length} errors, ${result.warnings.length} warnings.`,
      );
      void vscode.window.showErrorMessage(
        `STM32 Workbench: ${capitalize(result.stage)} failed — ${result.errors.length} errors, ${result.warnings.length} warnings`,
      );
    }
  }

  private reportProgrammerResult(result: FlashResult | ResetResult): void {
    const operation = result.stage === 'flash' ? 'Flash' : 'Reset';
    const duration = (result.durationMs / 1_000).toFixed(2);
    if (result.success) {
      this.output.appendLine(`\n[STM32] ${operation} succeeded in ${duration} s.`);
      void vscode.window.showInformationMessage(
        `STM32 Workbench: ${operation} succeeded (${duration} s)`,
      );
    } else {
      const message = result.error ?? `${operation} failed`;
      this.output.appendLine(`\n[STM32] ${operation} failed: ${message}`);
      void vscode.window.showErrorMessage(
        `STM32 Workbench: ${operation} failed — ${message}`,
      );
    }
  }

  private updateProgress(
    operation: WorkbenchProgressOperation,
    status: WorkbenchProgressStatus,
    stage: string,
    percent: number,
    message: string,
  ): void {
    this.reportProgress?.({ operation, status, stage, percent, message });
  }

  private updateRunProgress(progress: RunProgress): void {
    const stages: Record<
      RunProgress['stage'],
      { readonly label: string; readonly percent: number }
    > = {
      idle: { label: 'Ready', percent: 0 },
      preparing: { label: 'Preparing', percent: 5 },
      building: { label: 'Build', percent: 10 },
      firmware: { label: 'Firmware', percent: 50 },
      device: { label: 'ST-LINK', percent: 54 },
      flashing: { label: 'Flash', percent: 58 },
      verifying: { label: 'Verify', percent: 85 },
      serial: { label: 'Serial', percent: 89 },
      resetting: { label: 'Reset', percent: 93 },
      waiting: { label: 'Waiting for MCU', percent: 97 },
      complete: { label: 'Build & Run complete', percent: 100 },
      failed: { label: 'Build & Run failed', percent: 100 },
    };
    const stage = stages[progress.stage];
    this.updateProgress(
      'run',
      progress.stage === 'complete'
        ? 'succeeded'
        : progress.stage === 'failed'
          ? 'failed'
          : 'running',
      stage.label,
      stage.percent,
      progress.message ?? stage.label,
    );
  }

  private logRunProgress(progress: RunProgress): void {
    const prefix = `[Run #${progress.runId}]`;
    const messages: Partial<Record<RunProgress['stage'], string>> = {
      preparing: 'Started',
      building: 'Building...',
      firmware: progress.message ?? 'Locating firmware...',
      device: 'Checking ST-LINK...',
      flashing: 'Flashing firmware...',
      verifying: 'Verify succeeded',
      serial: progress.message ?? 'Preparing serial...',
      resetting: 'Resetting target...',
      waiting: progress.message,
      complete: 'Complete',
      failed: `Failed: ${progress.message ?? 'Unknown error'}`,
    };
    const message = messages[progress.stage];
    if (message !== undefined) {
      this.output.appendLine(`${prefix} ${message}`);
    }
  }

  private reportRunResult(result: RunResult): void {
    const duration = (result.durationMs / 1_000).toFixed(2);
    if (!result.success) {
      this.output.appendLine(
        `[Run #${result.runId}] Failed at ${result.failedStage ?? 'unknown'}: ${result.error ?? 'Unknown error'}`,
      );
      void vscode.window.showErrorMessage(
        `STM32 Workbench: Run #${result.runId} failed — ${result.error ?? 'Unknown error'}`,
      );
      return;
    }

    if (result.readyDetected === true) {
      this.output.appendLine(
        `[Run #${result.runId}] Ready detected after ${result.readyElapsedMs ?? 0} ms`,
      );
    }

    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        this.output.appendLine(`[Run #${result.runId}] Warning: ${warning}`);
      }
      this.output.appendLine(`[Run #${result.runId}] Complete in ${duration} s`);
      void vscode.window.showWarningMessage(
        `STM32 Workbench: Run #${result.runId} completed with warnings (${duration} s)`,
      );
      return;
    }
    this.output.appendLine(`[Run #${result.runId}] Complete in ${duration} s`);
    void vscode.window.showInformationMessage(
      `STM32 Workbench: Run #${result.runId} complete (${duration} s)`,
    );
  }

  private logProject(project: Stm32ProjectInfo): void {
    if (!project.detected) {
      this.output.appendLine(
        project.reason === 'no-workspace'
          ? '[STM32] No workspace opened.'
          : '[STM32] No STM32 project detected.',
      );
      return;
    }
    this.output.appendLine(`[STM32] Project: ${project.projectName ?? 'Unknown'}`);
    this.output.appendLine(
      `[STM32] MCU: ${project.mcu ?? 'Unknown'} (${project.mcuDetection})`,
    );
    this.output.appendLine(`[STM32] Build system: ${project.buildSystem}`);
  }

  private logTools(tools: DevelopmentTools): void {
    for (const [label, tool] of [
      ['CMake', tools.cmake],
      ['Ninja', tools.ninja],
      ['ARM GCC', tools.armGcc],
      ['STM32CubeProgrammer', tools.programmer],
    ] as const) {
      this.output.appendLine(`[STM32] ${label}: ${tool.executable ?? 'not found'}`);
    }
  }

  private logDevice(status: DeviceStatus): void {
    if (!status.programmerAvailable) {
      this.output.appendLine('[STM32] ST-LINK: Programmer CLI not found.');
    } else if (status.probeConnected) {
      this.output.appendLine(`[STM32] ST-LINK: ${status.probes.length} connected.`);
    } else {
      this.output.appendLine('[STM32] ST-LINK: Not connected.');
    }
  }
}

function configuredToolPaths(): Partial<Record<ToolKind, string>> {
  const configuration = vscode.workspace.getConfiguration('stm32Workbench.tools');
  const mappings: readonly [ToolKind, string][] = [
    ['cmake', 'cmakePath'],
    ['ninja', 'ninjaPath'],
    ['arm-gcc', 'armGccPath'],
    ['programmer', 'programmerPath'],
  ];
  const result: Partial<Record<ToolKind, string>> = {};
  for (const [kind, key] of mappings) {
    const configured = configuration.get<string>(key, '').trim();
    if (configured.length > 0) {
      result[kind] = configured;
    }
  }
  return result;
}

function toolEnvironment(tools: DevelopmentTools): NodeJS.ProcessEnv {
  const directories = [tools.ninja.executable, tools.armGcc.executable]
    .filter((value): value is string => value !== undefined)
    .map((value) => path.dirname(value));
  const existingPath = process.env.PATH ?? '';
  return {
    ...process.env,
    PATH: [...new Set(directories), existingPath]
      .filter((value) => value.length > 0)
      .join(path.delimiter),
  };
}

function buildPreflight(
  project: Stm32ProjectInfo,
  tools: DevelopmentTools,
): string | undefined {
  if (!project.detected) {
    return project.reason === 'no-workspace'
      ? 'No workspace opened'
      : 'No STM32 project detected';
  }
  if (project.buildSystem === 'mdk') {
    return 'Keil MDK project detected. Import it to a native macOS CMake project before building';
  }
  if (project.buildSystem !== 'cmake') {
    return 'Supported CMake project not detected';
  }
  return tools.cmake.available ? undefined : 'CMake executable not found';
}

function programmerPreflight(
  project: Stm32ProjectInfo,
  status: DeviceStatus,
): string | undefined {
  if (!project.detected) {
    return project.reason === 'no-workspace'
      ? 'No workspace opened'
      : 'No STM32 project detected';
  }
  return devicePreflight(status);
}

function devicePreflight(status: DeviceStatus): string | undefined {
  if (!status.programmerAvailable) {
    return 'STM32CubeProgrammer CLI not found';
  }
  return status.probeConnected ? undefined : 'No ST-LINK probe detected';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preflightFailure(message: string): BuildResult {
  return {
    success: false,
    stage: 'configure',
    stdout: '',
    stderr: message,
    durationMs: 0,
    errors: [{ severity: 'error', message }],
    warnings: [],
  };
}

function flashFailure(message: string): FlashResult {
  return {
    success: false,
    stage: 'flash',
    stdout: '',
    stderr: '',
    durationMs: 0,
    verify: true,
    reset: false,
    error: message,
  };
}

function resetFailure(message: string): ResetResult {
  return {
    success: false,
    stage: 'reset',
    stdout: '',
    stderr: '',
    durationMs: 0,
    error: message,
  };
}
