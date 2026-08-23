import * as vscode from 'vscode';

import type {
  RtosDebugTools,
  RtosDetectionResult,
  RtosSnapshot,
} from '../types/rtos';

export interface RtosPanelState {
  readonly detection: RtosDetectionResult;
  readonly tools?: RtosDebugTools;
  readonly snapshot?: RtosSnapshot;
  readonly busy: boolean;
}

export interface RtosPanelHandlers {
  readonly onReady: () => void;
  readonly onRefreshDetection: () => void;
  readonly onCapture: () => void;
}

export class RtosPanelProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view?: vscode.WebviewView;
  private messageDisposable?: vscode.Disposable;

  public constructor(private readonly handlers: RtosPanelHandlers) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = createHtml(view.webview);
    this.messageDisposable?.dispose();
    this.messageDisposable = view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isRecord(message) || typeof message.type !== 'string') {
        return;
      }
      if (message.type === 'ready') {
        this.handlers.onReady();
      } else if (message.type === 'refreshDetection') {
        this.handlers.onRefreshDetection();
      } else if (message.type === 'capture') {
        this.handlers.onCapture();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.messageDisposable?.dispose();
      this.messageDisposable = undefined;
    });
  }

  public update(state: RtosPanelState): void {
    void this.view?.webview.postMessage({ type: 'state', state });
  }

  public show(): void {
    void vscode.commands.executeCommand('dockyard32.rtosView.focus');
  }

  public dispose(): void {
    this.messageDisposable?.dispose();
    this.view = undefined;
  }
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
  <title>Dockyard32 RTOS</title>
  <style>${styles()}</style>
</head>
<body>
  <main>
    <header>
      <div><strong id="kernel">RTOS not detected</strong><span id="meta"></span></div>
      <div class="buttons"><button id="detect" class="secondary">Detect</button><button id="capture" class="primary">Capture Snapshot</button></div>
    </header>
    <section id="notice" class="notice">Open an STM32 project to detect its RTOS.</section>
    <section class="summary" id="summary"></section>
    <nav class="tabs" aria-label="RTOS snapshot views">
      <button class="tab active" data-tab="tasks-view">Tasks</button>
      <button class="tab" data-tab="objects-view">Objects</button>
      <button class="tab" data-tab="relations-view">Relationships</button>
    </nav>
    <section id="tasks-view" class="tab-view active"><div class="table-wrap">
      <table>
        <thead><tr><th>Task</th><th>State</th><th>Priority</th><th>Stack</th><th>Runtime</th></tr></thead>
        <tbody id="tasks"><tr><td colspan="5" class="empty">No task snapshot</td></tr></tbody>
      </table>
    </div></section>
    <section id="objects-view" class="tab-view"><div class="table-wrap">
      <table>
        <thead><tr><th>Object</th><th>Type</th><th>Fill</th><th>Item</th><th>Holder</th><th>Waiting</th></tr></thead>
        <tbody id="objects"><tr><td colspan="6" class="empty">No registered objects</td></tr></tbody>
      </table>
    </div></section>
    <section id="relations-view" class="tab-view"><div class="table-wrap">
      <table>
        <thead><tr><th>Task</th><th>Relationship</th><th>Object</th><th>Owner</th></tr></thead>
        <tbody id="relations"><tr><td colspan="4" class="empty">No task/object relationships</td></tr></tbody>
      </table>
    </div></section>
    <footer id="footer"></footer>
  </main>
  <script nonce="${nonce}">${script()}</script>
</body>
</html>`;
}

function styles(): string {
  return `
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body { color: var(--vscode-foreground); background: var(--vscode-panel-background, var(--vscode-editor-background)); font: 13px var(--vscode-font-family); }
    main { min-height: 210px; height: 100%; display: grid; grid-template-rows: auto auto auto auto 1fr auto; gap: 8px; padding: 9px 11px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    header strong { font-size: 14px; }
    #meta { margin-left: 8px; color: var(--vscode-descriptionForeground); }
    .buttons { display: flex; gap: 7px; }
    button { height: 28px; padding: 3px 11px; border: 1px solid transparent; border-radius: 2px; cursor: pointer; font: inherit; }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    .notice { min-height: 20px; padding: 5px 8px; border-left: 3px solid var(--vscode-textLink-foreground); color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); }
    .notice.error { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
    .notice.warning { border-color: var(--vscode-notificationsWarningIcon-foreground); }
    .summary { display: flex; flex-wrap: wrap; gap: 7px 16px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border); }
    button.tab { height: 26px; padding: 2px 10px; border: 0; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); background: transparent; }
    button.tab:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    button.tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .tab-view { display: none; min-height: 0; overflow: hidden; }
    .tab-view.active { display: block; height: 100%; }
    .table-wrap { min-height: 80px; overflow: auto; border: 1px solid var(--vscode-panel-border); }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { padding: 6px 9px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; white-space: nowrap; }
    th { position: sticky; top: 0; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); font-size: 11px; font-weight: 600; }
    tr.running { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    td.task { font-family: var(--vscode-editor-font-family); }
    td.object { font-family: var(--vscode-editor-font-family); color: var(--vscode-symbolIcon-variableForeground, var(--vscode-foreground)); }
    td.relation { color: var(--vscode-textLink-foreground); }
    td.empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 18px; }
    .stack-risk { color: var(--vscode-errorForeground); font-weight: 600; }
    footer { min-height: 17px; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;
}

function script(): string {
  return `
    const vscode = acquireVsCodeApi();
    const kernel = document.getElementById('kernel');
    const meta = document.getElementById('meta');
    const notice = document.getElementById('notice');
    const summary = document.getElementById('summary');
    const tasks = document.getElementById('tasks');
    const objects = document.getElementById('objects');
    const relations = document.getElementById('relations');
    const footer = document.getElementById('footer');
    const detect = document.getElementById('detect');
    const capture = document.getElementById('capture');
    detect.addEventListener('click', () => vscode.postMessage({ type: 'refreshDetection' }));
    capture.addEventListener('click', () => vscode.postMessage({ type: 'capture' }));
    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
      document.querySelectorAll('.tab-view').forEach(view => view.classList.toggle('active', view.id === tab.dataset.tab));
    }));
    function text(value) { return value === undefined || value === null ? '—' : String(value); }
    function setNotice(message, kind = '') { notice.textContent = message; notice.className = 'notice' + (kind ? ' ' + kind : ''); }
    function emptyRow(body, columns, message) {
      const row = document.createElement('tr'); const cell = document.createElement('td');
      cell.colSpan = columns; cell.className = 'empty'; cell.textContent = message;
      row.appendChild(cell); body.appendChild(row);
    }
    function render(state) {
      const detection = state.detection;
      detect.disabled = state.busy;
      capture.disabled = state.busy || !detection.detected || detection.kernel !== 'freertos' || !detection.elfPath;
      if (!detection.detected) {
        kernel.textContent = 'RTOS not detected'; meta.textContent = '';
        const detectionWarning = detection.warnings && detection.warnings[0];
        setNotice(state.busy ? 'Detecting project RTOS…' : detectionWarning || 'No supported RTOS was detected. Detection remains automatic.', state.busy ? '' : 'warning');
      } else {
        kernel.textContent = detection.kernel === 'freertos' ? 'FreeRTOS' : detection.kernel;
        meta.textContent = [detection.version, detection.cmsisWrapper && 'CMSIS-RTOS ' + detection.cmsisWrapper.toUpperCase(), detection.confidence].filter(Boolean).join(' · ');
        if (state.busy) setNotice('Reading RTOS state through ST-LINK and GDB…');
        else if (!detection.elfPath) setNotice('RTOS detected. Build a debug ELF before capturing tasks.', 'warning');
        else if (detection.kernel !== 'freertos') setNotice((detection.kernel === 'threadx' ? 'ThreadX' : 'Zephyr') + ' detected. Detection only; live task reading is not supported yet.', 'warning');
        else setNotice('RTOS matched automatically. Capture briefly halts the target, reads task state, then detaches.');
      }
      const snapshot = state.snapshot;
      tasks.replaceChildren();
      objects.replaceChildren();
      relations.replaceChildren();
      if (!snapshot || !snapshot.success || snapshot.tasks.length === 0) {
        emptyRow(tasks, 5, snapshot && snapshot.error ? snapshot.error : 'No task snapshot');
      } else {
        for (const task of snapshot.tasks) {
          const row = document.createElement('tr'); if (task.state === 'running') row.className = 'running';
          const stack = task.stackUsedPercent === undefined ? (task.stackFreeBytes === undefined ? '—' : task.stackFreeBytes + ' B free') : task.stackUsedPercent.toFixed(1) + '% used';
          const values = [task.name, task.state, task.priority, stack, task.runtimePercent === undefined ? '—' : task.runtimePercent.toFixed(1) + '%'];
          values.forEach((value, index) => { const cell = document.createElement('td'); cell.textContent = text(value); if (index === 0) cell.className = 'task'; if (index === 3 && task.stackUsedPercent >= 90) cell.classList.add('stack-risk'); row.appendChild(cell); });
          tasks.appendChild(row);
        }
      }
      const taskByAddress = new Map((snapshot?.tasks || []).map(task => [task.address, task]));
      const objectByAddress = new Map((snapshot?.objects || []).map(object => [object.address, object]));
      const taskName = address => taskByAddress.get(address)?.name || (address ? '0x' + address.toString(16) : '—');
      if (!snapshot?.success || !snapshot.objects || snapshot.objects.length === 0) {
        emptyRow(objects, 6, 'No registered queues, semaphores or mutexes');
      } else {
        for (const object of snapshot.objects) {
          const row = document.createElement('tr');
          const waiting = object.waitingToSendTaskAddresses.length + object.waitingToReceiveTaskAddresses.length;
          const values = [object.name, object.type, object.messagesWaiting + ' / ' + object.length, object.itemSize + ' B', taskName(object.holderTaskAddress), waiting];
          values.forEach((value, index) => { const cell = document.createElement('td'); cell.textContent = text(value); if (index === 0) cell.className = 'object'; row.appendChild(cell); });
          objects.appendChild(row);
        }
      }
      if (!snapshot?.success || !snapshot.relations || snapshot.relations.length === 0) {
        emptyRow(relations, 4, 'No current task/object relationships');
      } else {
        const labels = { 'waits-to-receive': 'waits to receive →', 'waits-to-send': 'waits to send →', 'waits-for-mutex': 'waits for mutex →', holds: 'holds →' };
        for (const relation of snapshot.relations) {
          const object = objectByAddress.get(relation.objectAddress);
          const owner = object?.holderTaskAddress;
          const values = [taskName(relation.taskAddress), labels[relation.kind] || relation.kind, object?.name || '0x' + relation.objectAddress.toString(16), relation.kind === 'waits-for-mutex' ? taskName(owner) : '—'];
          const row = document.createElement('tr');
          values.forEach((value, index) => { const cell = document.createElement('td'); cell.textContent = text(value); if (index === 0) cell.className = 'task'; if (index === 1) cell.className = 'relation'; if (index === 2) cell.classList.add('object'); row.appendChild(cell); });
          relations.appendChild(row);
        }
      }
      const counts = snapshot?.success ? Object.entries(snapshot.tasks.reduce((result, task) => { result[task.state] = (result[task.state] || 0) + 1; return result; }, {})).map(([name, count]) => name + ' ' + count) : [];
      summary.textContent = snapshot?.success ? 'Tasks ' + snapshot.tasks.length + ' · Objects ' + (snapshot.objects?.length || 0) + ' · Relationships ' + (snapshot.relations?.length || 0) + (counts.length ? ' · ' + counts.join(' · ') : '') : '';
      const tools = state.tools || {};
      footer.textContent = [tools.gdbExecutable ? 'GDB detected' : 'GDB missing', tools.gdbServerExecutable ? 'ST-LINK GDB server detected' : 'GDB server missing', snapshot?.capturedAt ? 'Captured ' + new Date(snapshot.capturedAt).toLocaleTimeString() : ''].filter(Boolean).join(' · ');
      if (snapshot && !snapshot.success) setNotice((snapshot.error || 'RTOS snapshot failed') + (snapshot.targetResumed ? '' : ' The target may still be paused; reset or resume it before continuing.'), 'error');
      else if (snapshot?.warnings?.length) setNotice(snapshot.warnings[0], 'warning');
    }
    window.addEventListener('message', event => { if (event.data?.type === 'state') render(event.data.state); });
    vscode.postMessage({ type: 'ready' });
  `;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () =>
    alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
