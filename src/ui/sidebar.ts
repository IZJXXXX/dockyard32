import * as vscode from 'vscode';

import type { BuildResult } from '../types/build';
import type { DeviceStatus } from '../types/device';
import type { FlashResult, ResetResult } from '../types/flash';
import type { Stm32ProjectInfo } from '../types/project';
import type { SerialPortInfo, SerialStatus } from '../types/serial';
import type { RunProgress, RunResult } from '../types/run';
import type { DevelopmentTools, DiscoveredTool } from '../types/tools';

type SidebarNode = SidebarSection | SidebarValue;

interface SidebarSection {
  readonly kind: 'section';
  readonly label: string;
  readonly icon: string;
  readonly children: readonly SidebarValue[];
}

interface SidebarValue {
  readonly kind: 'value';
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon?: string;
  readonly command?: vscode.Command;
}

type BuildState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly stage: 'detecting' | 'building' }
  | { readonly kind: 'finished'; readonly result: BuildResult };

type ProgrammerState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly stage: 'flash' | 'reset' }
  | {
      readonly kind: 'finished';
      readonly result: FlashResult | ResetResult;
    };

type RunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'preparing' }
  | { readonly kind: 'running'; readonly progress: RunProgress }
  | { readonly kind: 'finished'; readonly result: RunResult }
  | { readonly kind: 'preparation-failed'; readonly error: string };

export class WorkbenchSidebarProvider
  implements vscode.TreeDataProvider<SidebarNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    SidebarNode | undefined
  >();

  private projectInfo?: Stm32ProjectInfo;
  private tools?: DevelopmentTools;
  private deviceStatus?: DeviceStatus;
  private serialPorts: readonly SerialPortInfo[] = [];
  private serialStatus?: SerialStatus;
  private detecting = true;
  private detectingHardware = true;
  private buildState: BuildState = { kind: 'idle' };
  private programmerState: ProgrammerState = { kind: 'idle' };
  private runState: RunState = { kind: 'idle' };

  public readonly onDidChangeTreeData = this.changeEmitter.event;

  public setDetecting(): void {
    this.detecting = true;
    this.refresh();
  }

  public setProjectInfo(projectInfo: Stm32ProjectInfo): void {
    this.projectInfo = projectInfo;
    this.detecting = false;
    this.refresh();
  }

  public setHardwareDetecting(): void {
    this.detectingHardware = true;
    this.refresh();
  }

  public setHardwareStatus(
    tools: DevelopmentTools,
    deviceStatus: DeviceStatus,
  ): void {
    this.tools = tools;
    this.deviceStatus = deviceStatus;
    this.detectingHardware = false;
    this.refresh();
  }

  public setBuildRunning(stage: 'detecting' | 'building'): void {
    this.buildState = { kind: 'running', stage };
    this.refresh();
  }

  public setBuildResult(result: BuildResult): void {
    this.buildState = { kind: 'finished', result };
    this.refresh();
  }

  public setProgrammerRunning(stage: 'flash' | 'reset'): void {
    this.programmerState = { kind: 'running', stage };
    this.refresh();
  }

  public setProgrammerResult(result: FlashResult | ResetResult): void {
    this.programmerState = { kind: 'finished', result };
    this.refresh();
  }

  public setSerialPorts(ports: readonly SerialPortInfo[]): void {
    this.serialPorts = ports;
    this.refresh();
  }

  public setSerialStatus(status: SerialStatus): void {
    this.serialStatus = status;
    this.refresh();
  }

  public setRunPreparing(): void {
    this.runState = { kind: 'preparing' };
    this.refresh();
  }

  public setRunProgress(progress: RunProgress): void {
    this.runState = { kind: 'running', progress };
    this.refresh();
  }

  public setRunResult(result: RunResult): void {
    this.runState = { kind: 'finished', result };
    this.refresh();
  }

  public setRunPreparationFailure(error: string): void {
    this.runState = { kind: 'preparation-failed', error };
    this.refresh();
  }

  public refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  public getTreeItem(element: SidebarNode): vscode.TreeItem {
    if (element.kind === 'section') {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(element.icon);
      item.contextValue = 'stm32Workbench.section';
      return item;
    }

    const item = new vscode.TreeItem(
      element.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = element.description;
    item.tooltip = element.tooltip ?? element.label;
    item.iconPath = element.icon
      ? new vscode.ThemeIcon(element.icon)
      : undefined;
    item.command = element.command;
    item.contextValue = element.command
      ? 'stm32Workbench.action'
      : 'stm32Workbench.value';
    return item;
  }

  public getChildren(element?: SidebarNode): SidebarNode[] {
    if (element === undefined) {
      return this.createSections();
    }

    return element.kind === 'section' ? [...element.children] : [];
  }

  private createSections(): SidebarSection[] {
    return [
      this.createProjectSection(),
      this.createMcuSection(),
      this.createRunSection(),
      this.createBuildSection(),
      this.createToolsSection(),
      this.createStLinkSection(),
      this.createProgrammerSection(),
      this.createSerialSection(),
      this.createAgentSection(),
    ];
  }

  private createProjectSection(): SidebarSection {
    if (this.detecting) {
      return section('Project', 'folder-library', [
        value('Detecting project…', undefined, 'loading~spin'),
      ]);
    }

    const project = this.projectInfo;
    if (project?.reason === 'no-workspace') {
      return section('Project', 'folder-library', [
        value('No workspace opened', undefined, 'info'),
      ]);
    }
    if (project?.detected !== true) {
      return section('Project', 'folder-library', [
        value('No STM32 project detected', undefined, 'warning'),
      ]);
    }

    const children: SidebarValue[] = [
      {
        kind: 'value',
        label: project.projectName ?? 'STM32 project',
        description: 'Browse',
        icon: 'folder-opened',
        tooltip: 'Open Project Files. This is navigation only and does not run a build or target action.',
        command: {
          command: 'stm32Workbench.showProjectFiles',
          title: 'Show Project Files',
        },
      },
      value(
        project.buildSystem === 'cmake'
          ? 'CMake'
          : project.buildSystem === 'mdk' ? 'Keil MDK · Import required' : 'Build system not detected',
        undefined,
        project.buildSystem === 'cmake' || project.buildSystem === 'mdk' ? 'tools' : 'warning',
      ),
    ];
    if (project.projectRoot !== undefined) {
      children.push(
        value(
          project.projectRoot,
          undefined,
          'location',
          project.projectRoot,
        ),
      );
    }
    return section('Project', 'folder-library', children);
  }

  private createMcuSection(): SidebarSection {
    const project = this.projectInfo;
    if (this.detecting) {
      return section('MCU', 'circuit-board', [
        value('Detecting MCU…', undefined, 'loading~spin'),
      ]);
    }
    if (project?.detected !== true) {
      return section('MCU', 'circuit-board', [
        value('Not detected', undefined, 'chip'),
      ]);
    }

    const confidence =
      project.mcuDetection === 'exact'
        ? 'Exact'
        : project.mcuDetection === 'inferred'
          ? 'Inferred'
          : 'Unknown';
    return section('MCU', 'circuit-board', [
      value(project.mcu ?? 'Unknown MCU', confidence, 'chip'),
      value(project.family ?? 'Unknown family', undefined, 'symbol-class'),
    ]);
  }

  private createRunSection(): SidebarSection {
    const runState = this.runState;
    if (runState.kind === 'idle') {
      return section('Last Run', 'run-all', [
        value('Not run yet', undefined, 'circle-outline'),
      ]);
    }
    if (runState.kind === 'preparing') {
      return section('Last Run', 'run-all', [
        value('Saving files…', undefined, 'loading~spin'),
      ]);
    }
    if (runState.kind === 'preparation-failed') {
      return section('Last Run', 'run-all', [
        value('Preparation failed', undefined, 'error', runState.error),
      ]);
    }
    if (runState.kind === 'running') {
      return section('Last Run', 'run-all', [
        value(`Run #${runState.progress.runId}`, undefined, 'run-all'),
        value(
          runStageLabel(runState.progress.stage),
          undefined,
          'loading~spin',
          runState.progress.message,
        ),
      ]);
    }

    const result = runState.result;
    const children: SidebarValue[] = [
      value(
        `Run #${result.runId}`,
        `${(result.durationMs / 1_000).toFixed(2)} s`,
        result.success
          ? result.status === 'warning'
            ? 'warning'
            : 'pass-filled'
          : 'error',
        result.error,
      ),
    ];
    children.push(runStepValue('Build', result.build?.success));
    children.push(runStepValue('Flash', result.flash?.success));
    if (result.flash?.verify === true) {
      children.push(
        runStepValue(
          'Verify',
          result.failedStage === 'flashing' ? undefined : result.flash.success,
        ),
      );
    }
    children.push(
      value(
        result.serialConnected ? 'Serial connected' : 'Serial unavailable',
        result.serialPort,
        result.serialConnected ? 'pass-filled' : 'warning',
      ),
    );
    children.push(runStepValue('Reset', result.reset?.success));
    if (result.readyCheckEnabled) {
      children.push(
        value(
          result.readyDetected ? 'Ready detected' : 'Ready not confirmed',
          result.readyElapsedMs === undefined
            ? undefined
            : `${result.readyElapsedMs} ms`,
          result.readyDetected ? 'pass-filled' : 'warning',
        ),
      );
    }
    if (result.warnings.length > 0) {
      children.push(
        value(
          `${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}`,
          undefined,
          'warning',
          result.warnings.join('\n'),
        ),
      );
    }
    return section('Last Run', 'run-all', children);
  }

  private createBuildSection(): SidebarSection {
    if (this.buildState.kind === 'running') {
      return section('Build', 'output', [
        value(
          this.buildState.stage === 'detecting'
            ? 'Detecting project…'
            : 'Building…',
          undefined,
          'loading~spin',
        ),
      ]);
    }
    if (this.buildState.kind === 'idle') {
      return section('Build', 'output', [
        value('Not built yet', undefined, 'circle-outline'),
      ]);
    }

    const result = this.buildState.result;
    const duration = `${(result.durationMs / 1_000).toFixed(2)} s`;
    return section('Build', 'output', [
      value(
        result.success ? 'Build succeeded' : 'Build failed',
        duration,
        result.success ? 'pass-filled' : 'error',
      ),
      value(
        `${result.errors.length} errors`,
        `${result.warnings.length} warnings`,
        result.errors.length > 0 ? 'error' : 'warning',
      ),
    ]);
  }

  private createToolsSection(): SidebarSection {
    if (this.detectingHardware || this.tools === undefined) {
      return section('Development Tools', 'tools', [
        value('Discovering tools…', undefined, 'loading~spin'),
      ]);
    }

    return section('Development Tools', 'tools', [
      toolValue('CMake', this.tools.cmake),
      toolValue('Ninja', this.tools.ninja),
      toolValue('ARM GCC', this.tools.armGcc),
      toolValue('Programmer', this.tools.programmer),
    ]);
  }

  private createStLinkSection(): SidebarSection {
    if (this.detectingHardware || this.deviceStatus === undefined) {
      return section('ST-LINK', 'plug', [
        value('Detecting probe…', undefined, 'loading~spin'),
      ]);
    }

    const status = this.deviceStatus;
    if (!status.programmerAvailable) {
      return section('ST-LINK', 'plug', [
        value('Programmer CLI not found', undefined, 'warning'),
      ]);
    }
    if (!status.probeConnected) {
      return section('ST-LINK', 'plug', [
        value('Not connected', status.error, 'circle-outline', status.error),
      ]);
    }

    const firstProbe = status.probes[0];
    const children: SidebarValue[] = [
      value(
        status.probes.length === 1
          ? 'Connected'
          : `${status.probes.length} probes connected`,
        undefined,
        'pass-filled',
      ),
    ];
    if (firstProbe?.serialNumber !== undefined) {
      children.push(
        value(firstProbe.serialNumber, 'Serial number', 'key', firstProbe.serialNumber),
      );
    }
    if (firstProbe?.firmwareVersion !== undefined) {
      children.push(value(firstProbe.firmwareVersion, 'Firmware', 'versions'));
    }
    return section('ST-LINK', 'plug', children);
  }

  private createProgrammerSection(): SidebarSection {
    if (this.programmerState.kind === 'running') {
      return section('Programmer', 'symbol-event', [
        value(
          this.programmerState.stage === 'flash' ? 'Flashing…' : 'Resetting…',
          undefined,
          'loading~spin',
        ),
      ]);
    }
    if (this.programmerState.kind === 'idle') {
      return section('Programmer', 'symbol-event', [
        value('No operation yet', undefined, 'circle-outline'),
      ]);
    }

    const result = this.programmerState.result;
    const duration = `${(result.durationMs / 1_000).toFixed(2)} s`;
    const operation = result.stage === 'flash' ? 'Flash' : 'Reset';
    const children: SidebarValue[] = [
      value(
        `${operation} ${result.success ? 'succeeded' : 'failed'}`,
        duration,
        result.success ? 'pass-filled' : 'error',
        result.error,
      ),
    ];
    if (result.stage === 'flash') {
      children.push(
        value(result.verify ? 'Verify enabled' : 'Verify disabled', undefined, 'verified'),
      );
    }
    if (result.chip !== undefined) {
      children.push(value(result.chip, 'Target', 'chip'));
    }
    return section('Programmer', 'symbol-event', children);
  }

  private createSerialSection(): SidebarSection {
    const status = this.serialStatus;
    const connected = status?.connected === true;
    const children: SidebarValue[] = [
      value(
        connected ? 'Connected' : 'Disconnected',
        connected ? `${status.baudRate ?? ''} baud` : `${this.serialPorts.length} ports`,
        connected ? 'pass-filled' : 'circle-outline',
        status?.lastError,
      ),
    ];
    if (connected && status.port !== undefined) {
      children.push(value(status.port, undefined, 'plug', status.port));
    }
    return section('Serial', 'terminal', children);
  }

  private createAgentSection(): SidebarSection {
    return section('Agent Integration', 'hubot', [
      value('MCP available', 'stdio', 'pass-filled'),
    ]);
  }
}

function section(
  label: string,
  icon: string,
  children: readonly SidebarValue[],
): SidebarSection {
  return { kind: 'section', label, icon, children };
}

function value(
  label: string,
  description?: string,
  icon?: string,
  tooltip?: string,
): SidebarValue {
  return { kind: 'value', label, description, icon, tooltip };
}

function toolValue(label: string, tool: DiscoveredTool): SidebarValue {
  if (!tool.available) {
    return value(label, 'Not found', 'warning');
  }
  return value(
    label,
    tool.source === 'path' ? 'PATH' : 'Detected',
    'pass-filled',
    tool.executable,
  );
}

function runStageLabel(stage: RunProgress['stage']): string {
  const labels: Record<RunProgress['stage'], string> = {
    idle: 'Idle',
    preparing: 'Preparing…',
    building: 'Building…',
    firmware: 'Finding firmware…',
    device: 'Checking ST-LINK…',
    flashing: 'Flashing…',
    verifying: 'Verifying…',
    serial: 'Preparing serial…',
    resetting: 'Resetting…',
    waiting: 'Waiting for ready…',
    complete: 'Complete',
    failed: 'Failed',
  };
  return labels[stage];
}

function runStepValue(label: string, success: boolean | undefined): SidebarValue {
  if (success === undefined) {
    return value(`${label} skipped`, undefined, 'circle-slash');
  }
  return value(
    `${label} ${success ? 'succeeded' : 'failed'}`,
    undefined,
    success ? 'pass-filled' : 'error',
  );
}
