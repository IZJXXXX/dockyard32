import * as path from 'node:path';

import * as vscode from 'vscode';

import { getDeviceStatus } from '../core/device';
import { detectProject } from '../core/project';
import { detectRtos, findElfArtifact } from '../core/rtos';
import {
  captureFreeRtosSnapshot,
  discoverRtosDebugTools,
} from '../core/rtosDebug';
import { RtosSnapshotStore } from '../core/rtosSnapshotStore';
import { discoverDevelopmentTools } from '../core/tools';
import type { RtosDebugTools, RtosDetectionResult, RtosSnapshot } from '../types/rtos';
import type { ToolKind } from '../types/tools';
import { RtosPanelProvider } from './rtosPanel';
import { Dockyard32SidebarProvider } from './sidebar';

export class RtosController implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Dockyard32 RTOS');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly snapshots = new RtosSnapshotStore();
  private detection: RtosDetectionResult = emptyDetection();
  private tools?: RtosDebugTools;
  private busy = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  public readonly panel: RtosPanelProvider;

  public constructor(private readonly sidebar: Dockyard32SidebarProvider) {
    this.panel = new RtosPanelProvider({
      onReady: (): void => this.publish(),
      onRefreshDetection: (): void => void this.refresh(),
      onCapture: (): void => void this.capture(),
    });
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/{*.ioc,FreeRTOSConfig.h,FreeRTOS.h,cmsis_os*.{c,h},tx_api.h,CMakeLists.txt,*.elf,*.axf,*.out}',
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.invalidateAndScheduleRefresh()),
      watcher.onDidChange(() => this.invalidateAndScheduleRefresh()),
      watcher.onDidDelete(() => this.invalidateAndScheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidateAndScheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('dockyard32.rtos') ||
          event.affectsConfiguration('dockyard32.tools') ||
          event.affectsConfiguration('stm32Workbench.rtos') ||
          event.affectsConfiguration('stm32Workbench.tools')) {
          this.invalidateAndScheduleRefresh();
        }
      }),
    );
  }

  public async initialize(): Promise<void> {
    await this.refresh();
  }

  public showPanel(): void {
    this.panel.show();
  }

  public async refresh(): Promise<RtosDetectionResult> {
    if (this.busy) {
      return this.detection;
    }
    this.busy = true;
    this.sidebar.setRtosDetecting();
    this.publish();
    try {
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      this.snapshots.updateContext({ workspacePath });
      const project = await detectProject(workspacePath);
      const developmentTools = await discoverDevelopmentTools({
        configured: configuredDevelopmentTools(),
      });
      this.tools = await discoverRtosDebugTools({
        configuredGdb: configurationPath('gdbPath'),
        configuredGdbServer: configurationPath('gdbServerPath'),
        armGccExecutable: developmentTools.armGcc.executable,
        programmerExecutable: developmentTools.programmer.executable,
      });
      const elfPath = await findElfArtifact(project);
      const nmExecutable = developmentTools.armGcc.executable === undefined
        ? undefined
        : path.join(path.dirname(developmentTools.armGcc.executable), 'arm-none-eabi-nm');
      this.detection = await detectRtos(project, {
        mode: rtosMode(),
        elfPath,
        nmExecutable,
      });
      this.snapshots.updateContext({
        workspacePath,
        kernel: this.detection.kernel,
        elfPath: this.detection.elfPath,
      });
      this.sidebar.setRtosDetection(this.detection);
      this.logDetection();
      return this.detection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.detection = detectionFailure(message);
      this.sidebar.setRtosDetection(this.detection);
      this.output.appendLine(`[RTOS] Detection failed: ${message}`);
      return this.detection;
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  public async capture(): Promise<RtosSnapshot | undefined> {
    if (this.busy) {
      void vscode.window.showInformationMessage(
        'Dockyard32 RTOS: A capture or detection operation is already in progress.',
      );
      return undefined;
    }
    await this.refresh();
    if (!this.detection.detected || this.detection.kernel !== 'freertos') {
      void vscode.window.showInformationMessage(
        this.detection.detected && this.detection.kernel !== 'freertos'
          ? `Dockyard32 RTOS: ${kernelLabel(this.detection.kernel)} is detected, but live capture is not supported yet.`
          : 'Dockyard32 RTOS: A FreeRTOS project was not detected.',
      );
      return undefined;
    }
    if (this.detection.elfPath === undefined) {
      void vscode.window.showInformationMessage(
        'Dockyard32 RTOS: Build a debug ELF before capturing an RTOS snapshot.',
      );
      return undefined;
    }
    this.busy = true;
    const snapshotToken = this.snapshots.token();
    this.output.show(true);
    this.output.appendLine('[RTOS] Capturing FreeRTOS tasks through ST-LINK GDB...');
    this.publish();
    try {
      const device = await getDeviceStatus(this.tools?.programmerExecutable);
      if (device.probes.length !== 1) {
        const message = device.probes.length === 0
          ? device.error ?? 'No ST-LINK probe is connected'
          : `Expected one ST-LINK probe, found ${device.probes.length}`;
        const failure = captureFailure(message, true);
        this.snapshots.commit(snapshotToken, failure);
        this.output.appendLine(`[RTOS] Capture failed: ${message}`);
        void vscode.window.showErrorMessage(`Dockyard32 RTOS: ${message}`);
        return failure;
      }
      const snapshot = await captureFreeRtosSnapshot({
        elfPath: this.detection.elfPath,
        ...this.tools,
        probeSerialNumber: device.probes[0]?.serialNumber,
        onOutput: (text) => this.output.append(text),
      });
      if (!this.snapshots.commit(snapshotToken, snapshot)) {
        this.output.appendLine('[RTOS] Discarded capture because the workspace, ELF, or RTOS changed.');
        return snapshot;
      }
      if (snapshot.success) {
        this.output.appendLine(
          `[RTOS] Captured ${snapshot.tasks.length} tasks, ` +
          `${snapshot.objects.length} objects, and ` +
          `${snapshot.relations.length} relationships.`,
        );
      } else {
        const pausedWarning = snapshot.targetResumed
          ? ''
          : ' The target may still be paused; reset or resume it before continuing.';
        this.output.appendLine(`[RTOS] Capture failed: ${snapshot.error ?? 'Unknown error'}${pausedWarning}`);
        void vscode.window.showErrorMessage(
          `Dockyard32 RTOS: ${snapshot.error ?? 'Snapshot capture failed'}${pausedWarning}`,
        );
      }
      return snapshot;
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  public dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.panel.dispose();
    this.output.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 350);
  }

  private invalidateAndScheduleRefresh(): void {
    this.snapshots.clear();
    this.publish();
    this.scheduleRefresh();
  }

  private publish(): void {
    this.panel.update({
      detection: this.detection,
      tools: this.tools,
      snapshot: this.snapshots.get(),
      busy: this.busy,
    });
  }

  private logDetection(): void {
    if (!this.detection.detected) {
      this.output.appendLine('[RTOS] No supported RTOS detected.');
      return;
    }
    this.output.appendLine(
      `[RTOS] ${this.detection.kernel ?? 'Unknown'} ${this.detection.version ?? ''} (${this.detection.confidence})`.trim(),
    );
    for (const item of this.detection.evidence) {
      this.output.appendLine(`[RTOS] Evidence: ${item}`);
    }
  }
}

function configuredDevelopmentTools(): Partial<Record<ToolKind, string>> {
  const configuration = vscode.workspace.getConfiguration('dockyard32.tools');
  const legacyConfiguration = vscode.workspace.getConfiguration('stm32Workbench.tools');
  const result: Partial<Record<ToolKind, string>> = {};
  for (const [kind, key] of [
    ['arm-gcc', 'armGccPath'],
    ['programmer', 'programmerPath'],
  ] as const) {
    const value = (
      configuration.get<string>(key, '').trim() ||
      legacyConfiguration.get<string>(key, '').trim()
    );
    if (value.length > 0) {
      result[kind] = value;
    }
  }
  return result;
}

function configurationPath(key: 'gdbPath' | 'gdbServerPath'): string | undefined {
  const value = vscode.workspace
    .getConfiguration('dockyard32.rtos')
    .get<string>(key, '')
    .trim() || vscode.workspace
      .getConfiguration('stm32Workbench.rtos')
      .get<string>(key, '')
      .trim();
  return value.length > 0 ? value : undefined;
}

function rtosMode(): 'auto' | 'off' | 'freertos' | 'threadx' | 'zephyr' {
  const configured = vscode.workspace
    .getConfiguration('dockyard32.rtos')
    .get<'auto' | 'off' | 'freertos' | 'threadx' | 'zephyr'>('mode');
  return configured ?? vscode.workspace
    .getConfiguration('stm32Workbench.rtos')
    .get<'auto' | 'off' | 'freertos' | 'threadx' | 'zephyr'>('mode', 'auto');
}

function emptyDetection(): RtosDetectionResult {
  return {
    detected: false,
    confidence: 'unknown',
    evidence: [],
    warnings: [],
  };
}

function detectionFailure(error: string): RtosDetectionResult {
  return {
    detected: false,
    confidence: 'unknown',
    evidence: [],
    warnings: [error],
  };
}

function captureFailure(error: string, targetResumed: boolean): RtosSnapshot {
  return {
    success: false,
    kernel: 'freertos',
    capturedAt: Date.now(),
    tasks: [],
    objects: [],
    relations: [],
    warnings: [],
    targetResumed,
    error,
  };
}

function kernelLabel(kernel: RtosDetectionResult['kernel']): string {
  return kernel === 'threadx' ? 'ThreadX' : kernel === 'zephyr' ? 'Zephyr' : 'FreeRTOS';
}
