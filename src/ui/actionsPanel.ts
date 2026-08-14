import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import type { WorkbenchProgress } from '../types/progress';

const ACTION_COMMANDS: Readonly<Record<string, string>> = {
  run: 'stm32Workbench.run',
  build: 'stm32Workbench.build',
  flash: 'stm32Workbench.flash',
  reset: 'stm32Workbench.reset',
  serial: 'stm32Workbench.openSerial',
  refresh: 'stm32Workbench.refresh',
  ai: 'stm32Workbench.openAiAssistant',
  mcp: 'stm32Workbench.showMcpSetup',
  importMdk: 'stm32Workbench.importMdk',
  exportMdk: 'stm32Workbench.exportMdk',
};

export class ActionsViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private readonly disposables: vscode.Disposable[] = [];
  private view?: vscode.WebviewView;
  private webview?: vscode.Webview;
  private progress: WorkbenchProgress = {
    status: 'idle',
    stage: 'Ready',
    message: 'Ready',
    percent: 0,
  };
  private visibleOperation?: WorkbenchProgress['operation'];

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webview = view.webview;
    view.webview.options = { enableScripts: true };
    view.webview.html = actionsHtml(view.webview);
    this.disposables.push(
      view.webview.onDidReceiveMessage(async (message: unknown) => {
        if (isReadyMessage(message)) {
          await view.webview.postMessage({
            type: 'progress',
            progress: this.progress,
          });
          return;
        }
        const action = actionFromMessage(message);
        const command = action === undefined ? undefined : ACTION_COMMANDS[action];
        if (command === undefined) {
          return;
        }
        try {
          await vscode.commands.executeCommand(command);
        } finally {
          await view.webview.postMessage({ type: 'actionComplete' });
        }
      }),
    );
  }

  public setProgress(progress: WorkbenchProgress): void {
    this.progress = progress;
    if (
      progress.status === 'running' &&
      progress.operation !== undefined &&
      progress.operation !== this.visibleOperation
    ) {
      this.visibleOperation = progress.operation;
      void this.revealProgress();
    } else if (progress.status !== 'running') {
      this.visibleOperation = undefined;
    }
    void this.webview?.postMessage({ type: 'progress', progress });
  }

  private async revealProgress(): Promise<void> {
    if (this.view !== undefined) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand('stm32Workbench.actions.focus');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function isReadyMessage(message: unknown): boolean {
  return typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>).type === 'ready';
}

function actionFromMessage(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  return record.type === 'runAction' && typeof record.action === 'string'
    ? record.action
    : undefined;
}

function actionsHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    body { padding: 0 10px 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    .progress-card { position: sticky; top: 0; z-index: 2; margin: 2px 0 10px; padding: 8px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    #progress-stage { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #progress-percent { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .progress-track { height: 4px; overflow: hidden; background: var(--vscode-progressBar-background, var(--vscode-editorWidget-border)); }
    #progress-bar { width: 0%; height: 100%; background: var(--vscode-progressBar-background, var(--vscode-focusBorder)); transition: width 120ms linear; }
    .progress-card.running #progress-bar { background: var(--vscode-progressBar-background, var(--vscode-focusBorder)); }
    .progress-card.succeeded #progress-bar { background: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
    .progress-card.failed #progress-bar { background: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }
    #progress-message { margin-top: 6px; min-height: 1.25em; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .notice { margin: 2px 0 10px; padding: 8px; border-left: 3px solid var(--vscode-focusBorder); background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); line-height: 1.4; }
    .action { margin: 8px 0; padding: 9px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .action strong { display: block; margin-bottom: 3px; font-weight: 600; }
    .action p { margin: 0 0 8px; color: var(--vscode-descriptionForeground); line-height: 1.35; }
    .tag { float: right; margin-left: 8px; padding: 1px 5px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; }
    .tag.write { border-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
    button { width: 100%; padding: 5px 8px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .55; cursor: default; }
    .secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .utilities { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; }
  </style>
</head>
<body>
  <div id="progress" class="progress-card idle" role="status" aria-live="polite">
    <div class="progress-head"><span id="progress-stage">Ready</span><span id="progress-percent">0%</span></div>
    <div class="progress-track"><div id="progress-bar"></div></div>
    <div id="progress-message">Ready</div>
  </div>
  <div class="notice"><strong>Actions are separate from status.</strong><br>Build starts directly. Actions that write to or control the target require confirmation.</div>
  <div class="action">
    <span class="tag write">Target write</span><strong>Build &amp; Run</strong>
    <p>Save, build, flash, verify, reset, then restore serial.</p>
    <button data-action="run">▶ Build &amp; Run…</button>
  </div>
  <div class="action">
    <span class="tag">Build only</span><strong>Build Project</strong>
    <p>Save source files and run the detected native macOS CMake build.</p>
    <button data-action="build">Build Project</button>
  </div>
  <div class="action">
    <span class="tag">Project conversion</span><strong>Import Keil MDK</strong>
    <p>Copy a .uvprojx project and convert it into a native macOS CMake/GNU Arm project.</p>
    <button class="secondary" data-action="importMdk">Import MDK to CMake…</button>
  </div>
  <div class="action">
    <span class="tag">Project conversion</span><strong>Export Keil MDK</strong>
    <p>Create an editable ARM Compiler 6 .uvprojx project from the configured CMake/Cube build.</p>
    <button class="secondary" data-action="exportMdk">Export CMake to MDK</button>
  </div>
  <div class="action">
    <span class="tag write">Target write</span><strong>Flash Firmware</strong>
    <p>Program and verify the current ELF or HEX through ST-LINK.</p>
    <button data-action="flash">Flash Firmware…</button>
  </div>
  <div class="action">
    <span class="tag write">Target control</span><strong>Reset Target</strong>
    <p>Issue an SWD reset to the connected STM32 target.</p>
    <button data-action="reset">Reset Target…</button>
  </div>
  <div class="utilities">
    <button class="secondary" data-action="serial">Serial Monitor</button>
    <button class="secondary" data-action="ai">AI Assistant</button>
    <button class="secondary" data-action="refresh">Refresh Status</button>
    <button class="secondary" data-action="mcp">MCP Setup</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const buttons = [...document.querySelectorAll('button[data-action]')];
    const progress = document.getElementById('progress');
    const progressStage = document.getElementById('progress-stage');
    const progressPercent = document.getElementById('progress-percent');
    const progressBar = document.getElementById('progress-bar');
    const progressMessage = document.getElementById('progress-message');
    for (const button of buttons) {
      button.addEventListener('click', () => {
        for (const candidate of buttons) candidate.disabled = true;
        vscode.postMessage({ type: 'runAction', action: button.dataset.action });
      });
    }
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'actionComplete') {
        for (const button of buttons) button.disabled = false;
        return;
      }
      if (event.data?.type !== 'progress') return;
      const update = event.data.progress;
      const percent = Math.max(0, Math.min(100, Number(update.percent) || 0));
      progress.className = 'progress-card ' + update.status;
      progressStage.textContent = update.stage || 'Ready';
      progressPercent.textContent = Math.round(percent) + '%';
      progressBar.style.width = percent + '%';
      progressMessage.textContent = update.message || update.stage || 'Ready';
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
