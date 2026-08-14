import * as vscode from 'vscode';

import { SerialService } from '../core/serial';
import type {
  SerialConfiguration,
  SerialPortInfo,
} from '../types/serial';
import {
  SerialPanelProvider,
  type SerialPanelConfiguration,
} from './serialPanel';
import { Dockyard32SidebarProvider } from './sidebar';

const DEFAULT_CONFIGURATION: SerialPanelConfiguration = {
  serialPort: 'auto',
  baudRate: 115_200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
};

export class SerialController implements vscode.Disposable {
  private readonly panel: SerialPanelProvider;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly removeListeners: Array<() => void> = [];
  private ports: readonly SerialPortInfo[] = [];
  private configuration = DEFAULT_CONFIGURATION;

  public constructor(
    private readonly sidebar: Dockyard32SidebarProvider,
    private readonly service: SerialService = new SerialService(),
  ) {
    this.panel = new SerialPanelProvider({
      onReady: (): void => this.sendSnapshot(),
      onRefreshPorts: (): void => void this.refreshPorts(),
      onConnect: (configuration): void => void this.connect(configuration),
      onDisconnect: (): void => void this.disconnect(),
      onSend: (text): void => void this.send(text),
      onClear: (): void => this.clear(),
      onSaveConfiguration: (configuration): void =>
        void this.saveConfiguration(configuration),
    });
    this.removeListeners.push(
      this.service.onDidReceiveLog((event) => {
        this.panel.appendLog(event.text, event.replace);
      }),
      this.service.onDidChangeStatus((status) => {
        this.panel.updateStatus(status);
        this.sidebar.setSerialStatus(status);
      }),
    );
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(
        'dockyard32.serialView',
        this.panel,
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('dockyard32.serial')) {
          this.configuration = readSerialConfiguration();
          this.sendSnapshot();
        }
      }),
    );
  }

  public async initialize(): Promise<void> {
    this.configuration = readSerialConfiguration();
    this.sidebar.setSerialStatus(this.service.getSerialStatus());
    await this.refreshPorts();
  }

  public showPanel(): void {
    this.panel.show();
  }

  public appendRunMarker(runId: number, timestamp = Date.now()): void {
    this.panel.appendMarker(runId, timestamp);
  }

  public async refreshPorts(): Promise<void> {
    this.ports = await this.service.listSerialPorts();
    this.panel.updatePorts(this.ports);
    this.sidebar.setSerialPorts(this.ports);
    this.sendSnapshot();
  }

  public dispose(): void {
    for (const removeListener of this.removeListeners) {
      removeListener();
    }
    this.panel.dispose();
    this.service.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async connect(
    panelConfiguration: SerialPanelConfiguration,
  ): Promise<void> {
    await this.saveConfiguration(panelConfiguration);
    const configuration = resolveConfiguration(panelConfiguration, this.ports);
    if (configuration === undefined) {
      const result = {
        success: false,
        error: 'No serial port is available. Connect a device and refresh ports.',
      };
      this.panel.showResult(result);
      return;
    }

    const result = await this.service.connectSerial(configuration);
    this.panel.showResult(result);
  }

  private async disconnect(): Promise<void> {
    const result = await this.service.disconnectSerial();
    this.panel.showResult(result);
  }

  private async send(text: string): Promise<void> {
    const result = await this.service.sendSerial(text);
    this.panel.showResult(result);
  }

  private clear(): void {
    const result = this.service.clearSerialLog();
    this.panel.showResult(result);
  }

  private async saveConfiguration(
    configuration: SerialPanelConfiguration,
  ): Promise<void> {
    this.configuration = configuration;
    const settings = vscode.workspace.getConfiguration('dockyard32.serial');
    const target = vscode.ConfigurationTarget.Workspace;
    await Promise.all([
      settings.update('port', configuration.serialPort, target),
      settings.update('baudRate', configuration.baudRate, target),
      settings.update('dataBits', configuration.dataBits, target),
      settings.update('stopBits', configuration.stopBits, target),
      settings.update('parity', configuration.parity, target),
    ]);
  }

  private sendSnapshot(): void {
    this.panel.updateSnapshot({
      ports: this.ports,
      configuration: this.configuration,
      status: this.service.getSerialStatus(),
      log: this.service.getSerialLog(),
    });
  }
}

export function readSerialConfiguration(): SerialPanelConfiguration {
  const settings = vscode.workspace.getConfiguration('dockyard32.serial');
  return {
    serialPort: settings.get<string>('port', DEFAULT_CONFIGURATION.serialPort),
    baudRate: settings.get<number>('baudRate', DEFAULT_CONFIGURATION.baudRate),
    dataBits: settings.get<SerialConfiguration['dataBits']>(
      'dataBits',
      DEFAULT_CONFIGURATION.dataBits,
    ),
    stopBits: settings.get<SerialConfiguration['stopBits']>(
      'stopBits',
      DEFAULT_CONFIGURATION.stopBits,
    ),
    parity: settings.get<SerialConfiguration['parity']>(
      'parity',
      DEFAULT_CONFIGURATION.parity,
    ),
  };
}

function resolveConfiguration(
  configuration: SerialPanelConfiguration,
  ports: readonly SerialPortInfo[],
): SerialConfiguration | undefined {
  const port =
    configuration.serialPort === 'auto'
      ? ports.find((candidate) => candidate.path.startsWith('/dev/cu.')) ?? ports[0]
      : ports.find((candidate) => candidate.path === configuration.serialPort) ?? {
          path: configuration.serialPort,
        };
  if (port === undefined) {
    return undefined;
  }
  return {
    path: port.path,
    baudRate: configuration.baudRate,
    dataBits: configuration.dataBits,
    stopBits: configuration.stopBits,
    parity: configuration.parity,
  };
}
