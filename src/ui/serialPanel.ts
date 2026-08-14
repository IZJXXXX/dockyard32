import * as vscode from 'vscode';

import type {
  SerialConfiguration,
  SerialOperationResult,
  SerialPortInfo,
  SerialStatus,
} from '../types/serial';

export interface SerialPanelConfiguration {
  readonly serialPort: string;
  readonly baudRate: number;
  readonly dataBits: SerialConfiguration['dataBits'];
  readonly stopBits: SerialConfiguration['stopBits'];
  readonly parity: SerialConfiguration['parity'];
}

export interface SerialPanelSnapshot {
  readonly ports: readonly SerialPortInfo[];
  readonly configuration: SerialPanelConfiguration;
  readonly status: SerialStatus;
  readonly log: string;
}

export type SerialPanelRequest =
  | { readonly type: 'ready' }
  | { readonly type: 'refreshPorts' }
  | { readonly type: 'connect'; readonly configuration: SerialPanelConfiguration }
  | { readonly type: 'disconnect' }
  | { readonly type: 'send'; readonly text: string }
  | { readonly type: 'clear' }
  | { readonly type: 'saveConfiguration'; readonly configuration: SerialPanelConfiguration };

export interface SerialPanelHandlers {
  readonly onReady: () => void;
  readonly onRefreshPorts: () => void;
  readonly onConnect: (configuration: SerialPanelConfiguration) => void;
  readonly onDisconnect: () => void;
  readonly onSend: (text: string) => void;
  readonly onClear: () => void;
  readonly onSaveConfiguration: (configuration: SerialPanelConfiguration) => void;
}

export class SerialPanelProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private static readonly maxDisplayCharacters = 1_100_000;
  private view?: vscode.WebviewView;
  private messageDisposable?: vscode.Disposable;
  private displayLog = '';
  private hasDisplayState = false;

  public constructor(private readonly handlers: SerialPanelHandlers) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = createHtml(webviewView.webview);
    this.messageDisposable?.dispose();
    this.messageDisposable = webviewView.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
    );
    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.messageDisposable?.dispose();
      this.messageDisposable = undefined;
    });
  }

  public show(): void {
    void vscode.commands.executeCommand('dockyard32.serialView.focus');
  }

  public updateSnapshot(snapshot: SerialPanelSnapshot): void {
    if (!this.hasDisplayState) {
      this.displayLog = snapshot.log;
      this.hasDisplayState = true;
    }
    this.postMessage({
      type: 'snapshot',
      snapshot: { ...snapshot, log: this.displayLog },
    });
  }

  public updateStatus(status: SerialStatus): void {
    this.postMessage({ type: 'status', status });
  }

  public updatePorts(ports: readonly SerialPortInfo[]): void {
    this.postMessage({ type: 'ports', ports });
  }

  public appendLog(text: string, replace: boolean): void {
    this.displayLog = replace ? text : `${this.displayLog}${text}`;
    this.displayLog = trimDisplayLog(
      this.displayLog,
      SerialPanelProvider.maxDisplayCharacters,
    );
    this.hasDisplayState = true;
    this.postMessage({ type: 'log', text, replace });
  }

  public appendMarker(runId: number, timestamp: number): void {
    const text = formatRunMarker(runId, timestamp);
    this.displayLog = trimDisplayLog(
      `${this.displayLog}${text}`,
      SerialPanelProvider.maxDisplayCharacters,
    );
    this.hasDisplayState = true;
    this.postMessage({ type: 'marker', text });
  }

  public showResult(result: SerialOperationResult): void {
    this.postMessage({ type: 'operationResult', result });
  }

  public dispose(): void {
    this.messageDisposable?.dispose();
    this.view = undefined;
  }

  private handleMessage(message: unknown): void {
    const request = parseRequest(message);
    if (request === undefined) {
      return;
    }

    switch (request.type) {
      case 'ready':
        this.handlers.onReady();
        break;
      case 'refreshPorts':
        this.handlers.onRefreshPorts();
        break;
      case 'connect':
        this.handlers.onConnect(request.configuration);
        break;
      case 'disconnect':
        this.handlers.onDisconnect();
        break;
      case 'send':
        this.handlers.onSend(request.text);
        break;
      case 'clear':
        this.handlers.onClear();
        break;
      case 'saveConfiguration':
        this.handlers.onSaveConfiguration(request.configuration);
        break;
    }
  }

  private postMessage(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }
}

function parseRequest(message: unknown): SerialPanelRequest | undefined {
  if (!isRecord(message) || typeof message.type !== 'string') {
    return undefined;
  }
  switch (message.type) {
    case 'ready':
    case 'refreshPorts':
    case 'disconnect':
    case 'clear':
      return { type: message.type };
    case 'send':
      return typeof message.text === 'string'
        ? { type: 'send', text: message.text }
        : undefined;
    case 'connect':
    case 'saveConfiguration': {
      const configuration = parseConfiguration(message.configuration);
      return configuration === undefined
        ? undefined
        : { type: message.type, configuration };
    }
    default:
      return undefined;
  }
}

function parseConfiguration(
  value: unknown,
): SerialPanelConfiguration | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const dataBits = Number(value.dataBits);
  const stopBits = Number(value.stopBits);
  const parity = value.parity;
  if (
    typeof value.serialPort !== 'string' ||
    !Number.isSafeInteger(value.baudRate) ||
    ![5, 6, 7, 8].includes(dataBits) ||
    ![1, 1.5, 2].includes(stopBits) ||
    !['none', 'even', 'odd', 'mark', 'space'].includes(String(parity))
  ) {
    return undefined;
  }
  return {
    serialPort: value.serialPort,
    baudRate: Number(value.baudRate),
    dataBits: dataBits as SerialConfiguration['dataBits'],
    stopBits: stopBits as SerialConfiguration['stopBits'],
    parity: parity as SerialConfiguration['parity'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createHtml(webview: vscode.Webview): string {
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>${serialStyles()}</style>
  <title>STM32 Serial</title>
</head>
<body>
  <main>
    <section class="toolbar" aria-label="Serial configuration">
      <label class="field port-field"><span>Port</span><select id="port"></select></label>
      <button id="refresh" class="secondary" title="Refresh serial ports">Refresh</button>
      <label class="field baud-field"><span>Baud</span><input id="baud" list="baud-rates" inputmode="numeric"></label>
      <datalist id="baud-rates">
        <option value="9600"><option value="19200"><option value="38400"><option value="57600">
        <option value="115200"><option value="230400"><option value="460800"><option value="921600">
      </datalist>
      <label class="field compact"><span>Data</span><select id="dataBits"><option>5</option><option>6</option><option>7</option><option selected>8</option></select></label>
      <label class="field compact"><span>Stop</span><select id="stopBits"><option>1</option><option>1.5</option><option>2</option></select></label>
      <label class="field parity-field"><span>Parity</span><select id="parity"><option value="none">None</option><option value="even">Even</option><option value="odd">Odd</option><option value="mark">Mark</option><option value="space">Space</option></select></label>
      <button id="connect" class="primary">Connect</button>
      <button id="disconnect" class="secondary">Disconnect</button>
    </section>
    <section class="status-row">
      <span id="indicator" class="indicator"></span><span id="status">Disconnected</span>
      <span id="counters">RX 0 B · TX 0 B</span>
      <span id="message" role="status"></span>
    </section>
    <pre id="log" tabindex="0" aria-label="Serial monitor output"></pre>
    <section class="send-row">
      <input id="sendText" type="text" placeholder="Enter text to send" autocomplete="off">
      <button id="send" class="primary">Send</button>
      <button id="clear" class="secondary">Clear</button>
      <label class="check"><input id="autoScroll" type="checkbox" checked> Auto Scroll</label>
    </section>
  </main>
  <script nonce="${nonce}">${serialScript()}</script>
</body>
</html>`;
}

function serialStyles(): string {
  return `
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; padding: 0; }
    body { color: var(--vscode-foreground); background: var(--vscode-panel-background, var(--vscode-editor-background)); font: 13px var(--vscode-font-family); }
    main { height: 100%; min-height: 180px; display: grid; grid-template-rows: auto auto 1fr auto; gap: 7px; padding: 8px 10px; }
    .toolbar, .send-row, .status-row { display: flex; align-items: end; gap: 7px; min-width: 0; }
    .toolbar { flex-wrap: wrap; }
    .field { display: grid; gap: 3px; min-width: 72px; }
    .field > span { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .port-field { flex: 2 1 240px; }
    .baud-field { width: 110px; }
    .compact { width: 70px; }
    .parity-field { width: 88px; }
    input, select, button { height: 28px; border: 1px solid var(--vscode-input-border, transparent); color: var(--vscode-input-foreground); background: var(--vscode-input-background); font: inherit; outline: none; border-radius: 2px; }
    input, select { padding: 3px 7px; }
    input:focus, select:focus, button:focus { border-color: var(--vscode-focusBorder); }
    button { padding: 3px 11px; cursor: pointer; }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border-color: transparent; }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled, input:disabled, select:disabled { opacity: 0.55; cursor: default; }
    .status-row { align-items: center; min-height: 18px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .indicator { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .indicator.connected { background: var(--vscode-testing-iconPassed, #73c991); }
    .indicator.error { background: var(--vscode-testing-iconFailed, #f14c4c); }
    #counters { margin-left: 8px; }
    #message { margin-left: auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    #message.error { color: var(--vscode-errorForeground); }
    #log { min-height: 70px; margin: 0; padding: 8px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--vscode-panel-border); background: var(--vscode-terminal-background, var(--vscode-editor-background)); color: var(--vscode-terminal-foreground, var(--vscode-editor-foreground)); font: 12px/1.45 var(--vscode-editor-font-family); user-select: text; }
    #sendText { flex: 1 1 auto; min-width: 120px; }
    .check { display: flex; align-items: center; gap: 5px; white-space: nowrap; color: var(--vscode-descriptionForeground); }
    .check input { width: auto; height: auto; }
    @media (max-width: 620px) { .toolbar { align-items: end; } .port-field { flex-basis: 100%; } .send-row { flex-wrap: wrap; } #sendText { flex-basis: 100%; } }
  `;
}

function serialScript(): string {
  return `
    const vscode = acquireVsCodeApi();
    const elements = Object.fromEntries(['port','refresh','baud','dataBits','stopBits','parity','connect','disconnect','indicator','status','counters','message','log','sendText','send','clear','autoScroll'].map(id => [id, document.getElementById(id)]));
    let ports = [];
    let status = { connected: false, state: 'disconnected', bytesReceived: 0, bytesSent: 0 };
    const previousState = vscode.getState() || {};
    elements.autoScroll.checked = previousState.autoScroll !== false;

    function configuration() {
      return {
        serialPort: elements.port.value || 'auto',
        baudRate: Number(elements.baud.value),
        dataBits: Number(elements.dataBits.value),
        stopBits: Number(elements.stopBits.value),
        parity: elements.parity.value,
      };
    }
    function post(type, payload = {}) { vscode.postMessage({ type, ...payload }); }
    function saveConfiguration() { post('saveConfiguration', { configuration: configuration() }); }
    function updatePorts(nextPorts, selected) {
      ports = nextPorts;
      const desired = selected || elements.port.value || 'auto';
      elements.port.replaceChildren();
      const automatic = document.createElement('option'); automatic.value = 'auto'; automatic.textContent = nextPorts.length ? 'Auto (' + nextPorts[0].path + ')' : 'Auto (no ports found)'; elements.port.appendChild(automatic);
      for (const port of nextPorts) { const option = document.createElement('option'); option.value = port.path; option.textContent = port.friendlyName ? port.path + ' — ' + port.friendlyName : port.path; option.title = [port.manufacturer, port.serialNumber, port.vendorId && port.productId ? port.vendorId + ':' + port.productId : ''].filter(Boolean).join(' · '); elements.port.appendChild(option); }
      elements.port.value = Array.from(elements.port.options).some(option => option.value === desired) ? desired : 'auto';
    }
    function updateStatus(nextStatus) {
      status = nextStatus;
      const busy = status.state === 'connecting' || status.state === 'disconnecting';
      elements.status.textContent = status.connected ? 'Connected · ' + status.port + ' @ ' + status.baudRate : status.state.charAt(0).toUpperCase() + status.state.slice(1);
      elements.counters.textContent = 'RX ' + status.bytesReceived + ' B · TX ' + status.bytesSent + ' B';
      elements.indicator.className = 'indicator' + (status.connected ? ' connected' : status.lastError ? ' error' : '');
      elements.connect.disabled = status.connected || busy;
      elements.disconnect.disabled = !status.connected || busy;
      elements.send.disabled = !status.connected;
      elements.port.disabled = status.connected || busy;
      elements.baud.disabled = status.connected || busy;
      elements.dataBits.disabled = status.connected || busy;
      elements.stopBits.disabled = status.connected || busy;
      elements.parity.disabled = status.connected || busy;
      if (status.lastError) showMessage(status.lastError, true);
    }
    function setLog(text, replace) {
      if (replace) elements.log.textContent = text; else elements.log.append(document.createTextNode(text));
      if (elements.autoScroll.checked) elements.log.scrollTop = elements.log.scrollHeight;
    }
    function appendMarker(text) { setLog(text, false); }
    function showMessage(text, error = false) { elements.message.textContent = text || ''; elements.message.className = error ? 'error' : ''; }
    elements.refresh.addEventListener('click', () => post('refreshPorts'));
    elements.connect.addEventListener('click', () => { const value = configuration(); if (!Number.isSafeInteger(value.baudRate) || value.baudRate <= 0) { showMessage('Enter a valid positive baud rate', true); return; } post('connect', { configuration: value }); });
    elements.disconnect.addEventListener('click', () => post('disconnect'));
    elements.send.addEventListener('click', () => { if (elements.sendText.value.length > 0) { post('send', { text: elements.sendText.value }); elements.sendText.value = ''; } });
    elements.sendText.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); elements.send.click(); } });
    elements.clear.addEventListener('click', () => post('clear'));
    for (const element of [elements.port, elements.baud, elements.dataBits, elements.stopBits, elements.parity]) element.addEventListener('change', saveConfiguration);
    elements.autoScroll.addEventListener('change', () => vscode.setState({ autoScroll: elements.autoScroll.checked }));
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'snapshot') { const snapshot = message.snapshot; updatePorts(snapshot.ports, snapshot.configuration.serialPort); elements.baud.value = String(snapshot.configuration.baudRate); elements.dataBits.value = String(snapshot.configuration.dataBits); elements.stopBits.value = String(snapshot.configuration.stopBits); elements.parity.value = snapshot.configuration.parity; updateStatus(snapshot.status); setLog(snapshot.log, true); }
      else if (message.type === 'ports') updatePorts(message.ports);
      else if (message.type === 'status') updateStatus(message.status);
      else if (message.type === 'log') setLog(message.text, message.replace);
      else if (message.type === 'marker') appendMarker(message.text);
      else if (message.type === 'operationResult') showMessage(message.result.message || message.result.error || '', !message.result.success);
    });
    post('ready');
  `;
}

function createNonce(): string {
  const characters =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return value;
}

function formatRunMarker(runId: number, timestamp: number): string {
  const date = new Date(timestamp);
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => value.toString().padStart(2, '0'))
    .join(':');
  const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
  return `\n────────────────────────────────\n▶ Run #${runId}    ${time}.${milliseconds}\n────────────────────────────────\n\n`;
}

function trimDisplayLog(value: string, maximum: number): string {
  return value.length > maximum ? value.slice(-maximum) : value;
}
